#!/usr/bin/env bash
#
# deploy/mws/anu-secrets.sh — читает три именованных секрета из MWS Secret
# Manager и кладёт их в tmpfs /run/anu/secrets (фаза L5a, docs/GENESIS_LIVE.md
# §7.3). Запускается только systemd-юнитом anu-secrets.service (oneshot,
# Before=anu-live.service, Before=docker.service) на самой VM — под профилем
# `mws`, установленным владельцем.
#
# Этот скрипт НЕ содержит никакого материала ключей и не принимает его как
# аргумент — вся авторизация идёт через локальный профиль mws на VM.
#
# Результат: /run/anu/secrets/<имя> — по одному файлу на секрет, режим 0400,
# владелец uid 1000. /run — tmpfs: значения не ложатся на постоянный диск и
# не переживают перезагрузку.
set -euo pipefail

readonly SECRET_DIR="/run/anu/secrets"
readonly SECRET_OWNER_UID="1000"
readonly SECRETS=(
  anu-live-provider-key
  anu-live-gateway-token
  anu-live-observer-token
)

# Имя проекта — внешний контекст, в публичном репозитории его нет.
# systemd-юнит подаёт его через EnvironmentFile=/etc/anu-live/target.env.
: "${MWS_PROJECT:?MWS_PROJECT не задан: он приходит из /etc/anu-live/target.env}"

# CLI живёт в /root/.local/bin, которого нет в PATH системного юнита.
# ИЗМЕРЕНО на Lab: `systemd-run --pipe /bin/sh -c 'echo $PATH'` даёт
# /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin и HOME=UNSET.
# Поэтому юнит выставляет HOME и PATH явно (drop-in 20-runtime-environment),
# а скрипт всё равно проверяет и говорит внятно, если этого не сделали.
readonly MWS_BIN="${MWS_BIN:-$(command -v mws || true)}"
[[ -n "$MWS_BIN" && -x "$MWS_BIN" ]] || {
  echo "anu-secrets: mws не найден в PATH (${PATH}). Юнит обязан выставлять PATH и HOME —" >&2
  echo "  см. deploy/mws/anu-secrets.service.d/20-runtime-environment.conf." >&2
  exit 1
}
command -v python3 >/dev/null 2>&1 || {
  echo "anu-secrets: python3 не найден в PATH — нечем разобрать ответ mws." >&2
  exit 1
}

# Каталог секретов обязан быть КАТАЛОГОМ и только 0700 root. Дублирует
# строку из /etc/tmpfiles.d/anu-live.conf на случай запуска до tmpfiles.
if [[ -e "$SECRET_DIR" && ! -d "$SECRET_DIR" ]]; then
  echo "anu-secrets: ${SECRET_DIR} существует и не является каталогом — отказ." >&2
  exit 1
fi
install -d -m 0700 -o root -g root "$SECRET_DIR"

cleanup_tmp() {
  # shellcheck disable=SC2317  # вызывается через trap
  find "$SECRET_DIR" -mindepth 1 -name "*.tmp.$$" -exec rm -f {} + 2>/dev/null || true
}
trap cleanup_tmp EXIT

# Разрешение версии секрета.
#
# ФОРМА ВЫЗОВА (прочитана из справки CLI): у `secret-version get-data`
# позиционный <id> вида
#   secretmanager/projects/{project}/secrets/{secret}/secretVersions/{version}
# и обязательный флаг --name. Что отдаёт вызов БЕЗ явной версии — не
# документировано, а значит после ротации мог бы молча остаться старый ключ.
# Поэтому версия разрешается явно: берём максимальную АКТИВНУЮ версию из
# `secret-version list --filter spec.active=true`.
# ANU_SECRET_VERSION позволяет пиннуть версию вручную (например, при откате).
resolve_version() {
  local name="$1" listing
  if [[ -n "${ANU_SECRET_VERSION:-}" ]]; then
    printf '%s' "$ANU_SECRET_VERSION"
    return 0
  fi
  if ! listing=$("$MWS_BIN" secretmanager secret-version list \
      --name "$name" --filter "spec.active=true" -f json 2>&1); then
    echo "anu-secrets: не удалось перечислить версии секрета ${name}: ${listing}" >&2
    return 1
  fi
  printf '%s' "$listing" | python3 -c '
import sys, json, re
raw = sys.stdin.read()
try:
    doc = json.loads(raw)
except Exception:
    sys.exit("anu-secrets: ответ secret-version list не JSON")
items = doc if isinstance(doc, list) else (doc.get("items") or doc.get("versions") or doc.get("data") or [])
versions = []
for item in items if isinstance(items, list) else []:
    text = json.dumps(item)
    for match in re.findall(r"/secretVersions/(\d+)", text):
        versions.append(int(match))
if not versions:
    sys.exit("anu-secrets: в ответе secret-version list не найдено ни одной активной версии; "
             "задайте ANU_SECRET_VERSION вручную и запишите факт в RUNBOOK.md §3")
print(max(versions))
'
}

for name in "${SECRETS[@]}"; do
  dest="${SECRET_DIR}/${name}"
  tmp="${dest}.tmp.$$"

  # Предохранитель: если после неудачной попытки на месте файла оказался
  # каталог (docker создаёт bind-источник каталогом, когда контейнер
  # стартует раньше секретов), `mv -f` положил бы секрет ВНУТРЬ него и
  # отрапортовал об успехе. Такой путь удаляется до записи.
  if [[ -e "$dest" && ! -f "$dest" ]]; then
    echo "anu-secrets: ${dest} существует и не является обычным файлом — удаляю перед записью." >&2
    rm -rf -- "$dest"
  fi

  version=$(resolve_version "$name")
  secret_id="secretmanager/projects/${MWS_PROJECT}/secrets/${name}/secretVersions/${version}"

  if ! payload=$("$MWS_BIN" secretmanager secret-version get-data \
      "$secret_id" --name "$name" -f json 2>&1); then
    echo "anu-secrets: не удалось прочитать секрет ${name} (версия ${version}): ${payload}" >&2
    rm -f "$tmp"
    exit 1
  fi

  # НЕПРОВЕРЕННЫЙ ФАКТ (docs/GENESIS_LIVE.md §8): точное имя поля с данными и
  # его кодировка. Ниже — рабочее предположение (поле data в base64, иначе
  # сырая строка); при первом реальном запуске подтвердить и вписать факт в
  # RUNBOOK.md §3.
  printf '%s' "$payload" | python3 -c '
import sys, json, base64
doc = json.load(sys.stdin)
value = None
for key in ("data", "value", "payload"):
    candidate = doc.get(key) if isinstance(doc, dict) else None
    if isinstance(candidate, str) and candidate:
        value = candidate
        break
if value is None:
    sys.exit("anu-secrets: не найдено поле с данными секрета в ответе mws")
try:
    out = base64.b64decode(value, validate=True).decode("utf-8", "strict")
except Exception:
    out = value
sys.stdout.write(out)
' > "$tmp"

  [[ -s "$tmp" ]] || { echo "anu-secrets: секрет ${name} прочитан пустым — отказ." >&2; rm -f "$tmp"; exit 1; }

  chown "${SECRET_OWNER_UID}:${SECRET_OWNER_UID}" "$tmp"
  chmod 0400 "$tmp"
  mv -f "$tmp" "$dest"
  [[ -f "$dest" ]] || { echo "anu-secrets: ${dest} не стал обычным файлом — отказ." >&2; exit 1; }
  # Отпечаток, а не значение: по нему проверяется, что ротация действительно
  # сменила материал ключа (RUNBOOK.md §6).
  echo "anu-secrets: записан ${dest} (0400, uid ${SECRET_OWNER_UID}, версия ${version}, sha256 $(sha256sum "$dest" | cut -c1-16)…)"
done

echo "anu-secrets: все секреты обновлены в ${SECRET_DIR}."
