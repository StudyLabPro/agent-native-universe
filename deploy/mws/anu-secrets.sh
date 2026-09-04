#!/usr/bin/env bash
#
# deploy/mws/anu-secrets.sh — читает три именованных секрета из MWS Secret
# Manager и кладёт их в tmpfs /run/anu/secrets (фаза L5a, docs/GENESIS_LIVE.md
# §7.3). Запускается только systemd-юнитом anu-secrets.service (oneshot,
# Before=anu-live.service) на самой VM anu-live-1 — под профилем `mws`,
# который на этот момент уже установлен владельцем вручную вместе с
# authorized key SA anu-live (см. cloud-init.yaml, TODO там же).
#
# Этот скрипт НЕ содержит никакого материала ключей и не принимает его как
# аргумент — вся авторизация идёт через локальный профиль mws на VM.
#
# Результат: /run/anu/secrets/<имя> — по одному файлу на секрет, режим 0400,
# владелец uid 1000 (тот же пользователь, что и в cloud-init.yaml и
# compose file-secrets). /run — tmpfs, содержимое никогда не попадает на
# персистентный диск и не переживает перезагрузку VM.
set -euo pipefail

readonly SECRET_DIR="/run/anu/secrets"
readonly SECRET_OWNER_UID="1000"
readonly SECRETS=(
  anu-live-provider-key
  anu-live-gateway-token
  anu-live-observer-token
)

command -v mws >/dev/null 2>&1 || {
  echo "anu-secrets: команда mws не найдена в PATH — секреты не прочитаны." >&2
  exit 1
}
command -v python3 >/dev/null 2>&1 || {
  echo "anu-secrets: python3 не найден в PATH — нечем разобрать ответ mws." >&2
  exit 1
}

install -d -m 0700 -o root -g root "$SECRET_DIR"

cleanup_tmp() {
  # shellcheck disable=SC2317  # вызывается через trap, не напрямую
  rm -f "${SECRET_DIR}"/*.tmp."$$"
}
trap cleanup_tmp EXIT

# НЕПРОВЕРЕННЫЙ ФАКТ (см. docs/GENESIS_LIVE.md §8): точное имя поля с
# данными секрета и его кодировка (base64 или сырые байты) в ответе
# `secretmanager secret-version get-data -f json` — подтвердить при первом
# реальном запуске на VM и вписать сюда результат. Ниже — рабочее
# предположение (поле data, значение в base64), которое нужно свериться и
# при необходимости поправить одной строкой.
for name in "${SECRETS[@]}"; do
  dest="${SECRET_DIR}/${name}"
  tmp="${dest}.tmp.$$"

  if ! payload=$(mws secretmanager secret-version get-data \
      --name "$name" -f json 2>&1); then
    echo "anu-secrets: не удалось прочитать секрет ${name}: ${payload}" >&2
    rm -f "$tmp"
    exit 1
  fi

  printf '%s' "$payload" \
    | python3 -c "import sys,json,base64; d=json.load(sys.stdin); v=d.get('data') or d.get('value') or d.get('payload'); sys.stdout.write(base64.b64decode(v).decode('utf-8', 'strict')) if isinstance(v, str) and v else sys.exit('anu-secrets: не найдено поле с данными секрета в ответе mws')" \
    > "$tmp"

  chown "${SECRET_OWNER_UID}:${SECRET_OWNER_UID}" "$tmp"
  chmod 0400 "$tmp"
  mv -f "$tmp" "$dest"
  echo "anu-secrets: записан ${dest} (0400, uid ${SECRET_OWNER_UID})"
done

echo "anu-secrets: все секреты обновлены в ${SECRET_DIR}."
