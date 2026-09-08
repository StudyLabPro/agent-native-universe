#!/usr/bin/env bash
#
# deploy/mws/restore-drill.sh — плановая проверка восстановления из
# disk-backup evidence-диска anu-live-evidence-01 (фаза L5a завершает эту
# проверку один раз при первом запуске; процедура и её периодичность как
# таковая — предмет фазы L5c, здесь только сам механизм).
#
# ВЫБРАННЫЙ ПОДХОД (см. формулировку задачи — "выбрать простейший безопасный
# путь и задокументировать выбор"): восстановленный диск НЕ присоединяется к
# уже работающей anu-live-1. У `mws compute vm create`/`update` create-or-
# update семантика для --storage-disks нигде не документирована (не ясно,
# заменяет ли повторная передача диск-листа целиком или добавляет элемент) —
# рисковать так живой вселенной ради учения недопустимо. Вместо этого драйв
# поднимает ОДНОРАЗОВУЮ scratch-VM в той же подсети anu-live-nodes:
#   - без внешнего адреса (не создаём новую точку входа из интернета);
#   - доступна по SSH только с внутреннего адреса anu-live-1 —
#     то есть оператор сначала заходит на anu-live-1 (уже разрешено
#     правилом ssh-from-owner), а оттуda — на scratch-VM;
#   - все ресурсы драйва (2 диска, VM, временное правило firewall)
#     удаляются в конце запуска независимо от результата (trap).
#
# Как и provision.sh, этот скрипт создаёт реальные ресурсы и требует того же
# явного подтверждения.
set -euo pipefail

# Локальный файл цели развёртывания (адреса, имя проекта, пользователь SSH).
# В git он не входит: этот репозиторий публичный, а адреса и идентификатор
# облачного проекта — внешний инфраструктурный контекст. Образец —
# deploy/mws/target.env.example.
__anu_target_env="${ANU_LIVE_TARGET_ENV:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/target.env}"
if [[ -f "$__anu_target_env" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$__anu_target_env"
  set +a
fi

readonly MWS_PROJECT="${MWS_PROJECT:?MWS_PROJECT не задан: заполните deploy/mws/target.env по образцу target.env.example}"
readonly MWS_ZONE="ru-central1-a"
readonly CONFIRM_FLAG="--yes-i-understand-this-costs-real-money"
readonly SOURCE_DISK="anu-live-evidence-01"
readonly BACKUP_PREFIX="anu-live-evidence-"
readonly DRILL_INTERNAL_IP="${ANU_DRILL_INTERNAL_IP:?ANU_DRILL_INTERNAL_IP не задан: заполните deploy/mws/target.env}"
readonly ANU_LIVE_INTERNAL_IP="${ANU_LIVE_INTERNAL_IP:?ANU_LIVE_INTERNAL_IP не задан: заполните deploy/mws/target.env}"
readonly LIVE_EXPERIMENT_ID="genesis-live"
readonly LIVE_UNIVERSE_ID="U0001"
DRILL_ID="drill-$(date +%Y%m%d%H%M%S)"
readonly DRILL_ID

: "${OWNER_SSH_PUBLIC_KEY_FILE:?$(cat <<'EOF'
Ошибка: переменная окружения OWNER_SSH_PUBLIC_KEY_FILE не задана.

Нужен путь к ОТКРЫТОМУ ключу оператора — он будет установлен на
одноразовую scratch-VM драйва через --os-metadata-attributes, чтобы
оператор мог зайти на неё с anu-live-1. Пример:

  OWNER_SSH_PUBLIC_KEY_FILE=~/.ssh/id_ed25519.pub ./deploy/mws/restore-drill.sh
EOF
)}"
[[ -r "$OWNER_SSH_PUBLIC_KEY_FILE" ]] || {
  echo "Ошибка: OWNER_SSH_PUBLIC_KEY_FILE указывает на нечитаемый файл: ${OWNER_SSH_PUBLIC_KEY_FILE}" >&2
  exit 1
}

command -v mws >/dev/null 2>&1 || { echo "Ошибка: mws не найден в PATH." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "Ошибка: python3 не найден в PATH." >&2; exit 1; }

idem_key() { python3 -c "import uuid,sys; print(uuid.uuid5(uuid.NAMESPACE_URL, sys.argv[1]))" "$1"; }

section() { printf '\n=== %s ===\n' "$1"; }
run() { printf '$ %s\n' "$*"; "$@"; }

# ---------------------------------------------------------------------------
# Предохранитель — тот же паттерн, что и в provision.sh
# ---------------------------------------------------------------------------
ASSUME_YES=0
for arg in "$@"; do
  [[ "$arg" == "$CONFIRM_FLAG" ]] && ASSUME_YES=1
done

section "Предохранитель: restore-drill создаёт реальные временные ресурсы"
cat <<EOF
Этот запуск временно создаст в проекте MWS ${MWS_PROJECT}:
  - диск anu-live-evidence-${DRILL_ID} (копия из последнего disk-backup)
  - диск anu-live-boot-${DRILL_ID} (пустая ОС для scratch-VM)
  - VM anu-live-${DRILL_ID} (без внешнего адреса, внутренний IP ${DRILL_INTERNAL_IP})
  - временное правило firewall drill-ssh-${DRILL_ID}
Всё перечисленное удаляется в конце этого запуска (успешного или нет).
Ни один вызов ниже не выполняется без вашего подтверждения.
EOF

if [[ "$ASSUME_YES" -eq 1 ]]; then
  echo "Флаг ${CONFIRM_FLAG} передан — пропускаю интерактивный вопрос."
else
  if [[ ! -t 0 ]]; then
    echo "Отказ: нет ни флага ${CONFIRM_FLAG}, ни интерактивного терминала. Ни один ресурс не создан." >&2
    exit 1
  fi
  read -r -p "Продолжить? [y/N] " REPLY
  case "$REPLY" in
    y|Y|yes|Yes|YES) ;;
    *) echo "Остановлено оператором. Ни один ресурс не создан." >&2; exit 1 ;;
  esac
fi

# ---------------------------------------------------------------------------
# Уборка: снести всё, что создал этот запуск, при любом исходе
# ---------------------------------------------------------------------------
CREATED_FIREWALL=0
CREATED_VM=0
CREATED_BOOT_DISK=0
CREATED_DRILL_DISK=0

cleanup() {
  section "Уборка ресурсов драйва ${DRILL_ID}"
  if [[ "$CREATED_VM" -eq 1 ]]; then
    mws compute vm delete "compute/projects/${MWS_PROJECT}/virtualMachines/anu-live-${DRILL_ID}" \
      --idempotency-key "$(idem_key "delete-vm-${DRILL_ID}")" || echo "Уборка: не удалось удалить VM (проверьте вручную)." >&2
  fi
  if [[ "$CREATED_FIREWALL" -eq 1 ]]; then
    mws vpc firewall-rule delete "vpc/projects/${MWS_PROJECT}/networks/anu-live/firewallRules/drill-ssh-${DRILL_ID}" \
      --network anu-live \
      --idempotency-key "$(idem_key "delete-fw-${DRILL_ID}")" || echo "Уборка: не удалось удалить правило firewall (проверьте вручную)." >&2
  fi
  if [[ "$CREATED_BOOT_DISK" -eq 1 ]]; then
    mws compute disk delete "compute/projects/${MWS_PROJECT}/disks/anu-live-boot-${DRILL_ID}" \
      --purge \
      --idempotency-key "$(idem_key "delete-boot-${DRILL_ID}")" || echo "Уборка: не удалось удалить boot-диск (проверьте вручную)." >&2
  fi
  if [[ "$CREATED_DRILL_DISK" -eq 1 ]]; then
    mws compute disk delete "compute/projects/${MWS_PROJECT}/disks/anu-live-evidence-${DRILL_ID}" \
      --purge \
      --idempotency-key "$(idem_key "delete-evidence-${DRILL_ID}")" || echo "Уборка: не удалось удалить восстановленный диск (проверьте вручную)." >&2
  fi
  echo "Уборка завершена. Если что-то выше сообщило об ошибке — удалите ресурс вручную (см. RUNBOOK.md)."
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Найти последний disk-backup evidence-диска
# ---------------------------------------------------------------------------
section "Поиск последнего disk-backup для ${SOURCE_DISK}"
LATEST_BACKUP="$(python3 - "$MWS_PROJECT" "$BACKUP_PREFIX" <<'PYEOF'
import json, subprocess, sys
project, prefix = sys.argv[1], sys.argv[2]
out = subprocess.run(
    ["mws", "compute", "disk-backup", "list", "--project", project,
     "--order-by", "metadata.createTime desc", "--page-size", "50", "-f", "json"],
    check=True, capture_output=True, text=True,
).stdout
page = json.loads(out) if out.strip() else {}
for item in page.get("items", page.get("results", [])):
    name = item.get("metadata", {}).get("id", {}).get("name", "")
    if name.startswith(prefix):
        print(name)
        break
PYEOF
)"

if [[ -z "$LATEST_BACKUP" ]]; then
  echo "Ошибка: не найдено ни одного disk-backup с префиксом ${BACKUP_PREFIX}. Драйв невозможен без хотя бы одной копии." >&2
  exit 1
fi
echo "Последний backup: ${LATEST_BACKUP}"

# ---------------------------------------------------------------------------
# 2. Восстановить evidence-диск из backup + создать scratch boot-диск
# ---------------------------------------------------------------------------
section "Создание дисков драйва"

run mws compute disk create "compute/projects/${MWS_PROJECT}/disks/anu-live-evidence-${DRILL_ID}" \
  --zone "${MWS_ZONE}" --disk-type compute/diskTypes/nbs-pl2 \
  --source-disk-backup "compute/projects/${MWS_PROJECT}/diskBackups/${LATEST_BACKUP}" \
  --idempotency-key "$(idem_key "drill-evidence-${DRILL_ID}")"
CREATED_DRILL_DISK=1

run mws compute disk create "compute/projects/${MWS_PROJECT}/disks/anu-live-boot-${DRILL_ID}" \
  --zone "${MWS_ZONE}" --size 20GB --os-type LINUX \
  --disk-type compute/diskTypes/nbs-pl2 \
  --source-image compute/projects/mws-ubuntu/images/mws-ubuntu-2404-lts-v20260324 \
  --idempotency-key "$(idem_key "drill-boot-${DRILL_ID}")"
CREATED_BOOT_DISK=1

# ---------------------------------------------------------------------------
# 3. Временное правило firewall: SSH только с anu-live-1, только на эту VM
# ---------------------------------------------------------------------------
section "Временное правило firewall drill-ssh-${DRILL_ID}"
# Приоритет в том же диапазоне, что и постоянные правила anu-live (§7.2,
# см. комментарий в provision.sh про диапазон [1000-64535]); 1020 держит его
# ниже deny-all-ingress (64535) и выше него не пересекается с постоянными
# правилами 1000/1005/1010.
run mws vpc firewall-rule create "vpc/projects/${MWS_PROJECT}/networks/anu-live/firewallRules/drill-ssh-${DRILL_ID}" \
  --network anu-live --direction INGRESS --action ALLOW --priority 1020 \
  --proto-ports tcp:22 \
  --source-spec-cidrs "${ANU_LIVE_INTERNAL_IP}/32" \
  --destination-spec-cidrs "${DRILL_INTERNAL_IP}/32" --active \
  --idempotency-key "$(idem_key "drill-fw-${DRILL_ID}")"
CREATED_FIREWALL=1

# ---------------------------------------------------------------------------
# 4. Scratch-VM: boot + восстановленный evidence, без внешнего адреса
# ---------------------------------------------------------------------------
section "Scratch-VM anu-live-${DRILL_ID}"
# НЕПРОВЕРЕННЫЙ ФАКТ: имя ключа метаданных для установки SSH-авторизованного
# ключа на MWS-образе mws-ubuntu (ниже использовано по распространённому в
# облаках соглашению "ssh-keys: user:key") — сверить при первом реальном
# запуске и поправить здесь при расхождении (см. §8 GENESIS_LIVE.md).
DRILL_SSH_PUBLIC_KEY="$(cat "$OWNER_SSH_PUBLIC_KEY_FILE")"
run mws compute vm create "compute/projects/${MWS_PROJECT}/virtualMachines/anu-live-${DRILL_ID}" \
  --zone "${MWS_ZONE}" --vm-type compute/vmTypes/base-4-8 \
  --os-hostname "anu-live-${DRILL_ID}" \
  --os-metadata-attributes "ssh-keys: \"drill:${DRILL_SSH_PUBLIC_KEY}\"" \
  --storage-disks "boot: true, deviceName: boot, disk: {ref: \"compute/projects/${MWS_PROJECT}/disks/anu-live-boot-${DRILL_ID}\"}" \
  --storage-disks "boot: false, deviceName: evidence, disk: {ref: \"compute/projects/${MWS_PROJECT}/disks/anu-live-evidence-${DRILL_ID}\"}" \
  --network-interfaces "primary: true, name: eth0, addresses: [{address: {spec: {subnet: \"vpc/projects/${MWS_PROJECT}/networks/anu-live/subnets/anu-live-nodes\", ipAddress: ${DRILL_INTERNAL_IP}}}}]" \
  --idempotency-key "$(idem_key "drill-vm-${DRILL_ID}")"
CREATED_VM=1

section "Ожидание готовности VM"
# НЕПРОВЕРЕННЫЙ ФАКТ: точное поле готовности в `compute vm get -f json`
# (использовано грубое совпадение подстроки "READY"/"RUNNING" — заменить на
# точный jsonpath после первого реального запуска).
READY=0
for _ in $(seq 1 30); do
  STATE_JSON="$(mws compute vm get "compute/projects/${MWS_PROJECT}/virtualMachines/anu-live-${DRILL_ID}" -f json || true)"
  if grep -qiE 'READY|RUNNING' <<<"$STATE_JSON"; then
    READY=1
    break
  fi
  sleep 10
done
if [[ "$READY" -ne 1 ]]; then
  echo "Ошибка: scratch-VM не сообщила о готовности за отведённое время." >&2
  exit 1
fi

cat <<EOF

Scratch-VM anu-live-${DRILL_ID} готова на внутреннем адресе ${DRILL_INTERNAL_IP}.

ДАЛЬШЕ — РУЧНОЙ ШАГ ОПЕРАТОРА (этот скрипт SSH не выполняет; удалённое
исполнение на непроверенном свежесозданном хосте — риск, ручной контроль
здесь уместнее автоматизации):

  1. ssh -J owner@anu-live-1 drill@${DRILL_INTERNAL_IP}
  2. На scratch-VM: смонтировать восстановленный диск (устройство обычно
     /dev/vdb или /dev/disk/by-id/virtio-evidence — свериться через lsblk),
     например: sudo mkdir -p /mnt/anu-live-drill &&
     sudo mount -o ro /dev/vdb /mnt/anu-live-drill
     (диск смонтирован READ-ONLY — драйв никогда не пишет в саму копию,
     только читает и, при необходимости truncate, работает на ОТДЕЛЬНОЙ
     рабочей копии файла событий, см. шаг 3).
  3. Найти последний эпох в индексе цепочки и его runId:
     LATEST_EPOCH=\$(ls /mnt/anu-live-drill/${LIVE_EXPERIMENT_ID}/${LIVE_UNIVERSE_ID}/chain/*.json \\
       | sed -E 's#.*/([0-9]+)\\.json#\\1#' | sort -n | tail -1)
     RUN_ID=\$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['runId'])" \\
       "/mnt/anu-live-drill/${LIVE_EXPERIMENT_ID}/${LIVE_UNIVERSE_ID}/chain/\${LATEST_EPOCH}.json")
  4. Скопировать (НЕ на смонтированном ro-диске) файл событий этого runId и
     обрезать хвост до последней ЗАВЕРШЁННОЙ строки (движок сам считает
     файл без конечного \\n повреждённым — см. src/lab/events.ts):
     WORKDIR=\$(mktemp -d)
     cp "/mnt/anu-live-drill/${LIVE_EXPERIMENT_ID}/${LIVE_UNIVERSE_ID}/\${RUN_ID}/events.jsonl" "\$WORKDIR/"
     # обрезка до последнего полного \\n-терминированного JSONL-события:
     python3 -c "
import sys
p = sys.argv[1]
data = open(p, 'rb').read()
cut = data.rfind(b'\\n')
open(p, 'wb').write(data[: cut + 1] if cut >= 0 else b'')
" "\$WORKDIR/events.jsonl"
     mkdir -p "\$WORKDIR/${LIVE_EXPERIMENT_ID}/${LIVE_UNIVERSE_ID}/\${RUN_ID}"
     cp "/mnt/anu-live-drill/${LIVE_EXPERIMENT_ID}/${LIVE_UNIVERSE_ID}/\${RUN_ID}/manifest.json" \\
        "/mnt/anu-live-drill/${LIVE_EXPERIMENT_ID}/${LIVE_UNIVERSE_ID}/\${RUN_ID}/config.json" \\
        "\$WORKDIR/${LIVE_EXPERIMENT_ID}/${LIVE_UNIVERSE_ID}/\${RUN_ID}/" 2>/dev/null || true
     mv "\$WORKDIR/events.jsonl" "\$WORKDIR/${LIVE_EXPERIMENT_ID}/${LIVE_UNIVERSE_ID}/\${RUN_ID}/events.jsonl"
  5. Прогнать реальный CLI движка (образ из scripts/live/build-push.sh):
     docker run --rm -v "\$WORKDIR:/data:ro" <registry-host>/anu/agent-native-universe-lab:<tag> \\
       node dist/cli/index.js lab replay --data-dir /data \\
       --experiment ${LIVE_EXPERIMENT_ID} --universe-id ${LIVE_UNIVERSE_ID} --run-id "\$RUN_ID"

ИЗВЕСТНЫЙ ПРОБЕЛ (зафиксировать как есть, не изобретать несуществующий
флаг): в архитектурном документе шаг 5 записан как
"anu lab replay --allow-incomplete-boundary". Реальный CLI (src/lab/runner.ts,
REPLAY_OPTIONS) такого флага НЕ поддерживает — только --data-dir,
--experiment, --run-id, --until-tick, --universe-id. Библиотечный метод
ReplayEngine.replayRecoverableFile с допуском allowIncompleteBoundary
существует (src/lab/replay.ts), но не прокинут в CLI. Если обрезка выше
случайно попала СЕРЕДИНУ тика (а не точно на границу), реальный вызов упадёт
с "Incomplete event stream does not end at a durable tick boundary" — это
ожидаемо для драйва, ловящего процесс в середине тика, и является поводом
завести отдельную задачу на CLI (не на этот скрипт).

Результат драйва (успех/частичный успех/ошибка и вывод шага 5) впишите в
RUNBOOK.md по образцу существующих операционных записей.
EOF

section "Готово (уборка ресурсов драйва произойдёт автоматически по выходу)"
