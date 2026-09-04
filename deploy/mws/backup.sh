#!/usr/bin/env bash
#
# deploy/mws/backup.sh — ежедневный disk-backup evidence-диска anu-live-1 и
# прополка старых копий сверх 14 последних (фаза L5a, docs/GENESIS_LIVE.md
# §7.2: "хранить 14 последних копий"). Запускается на самой VM anu-live-1
# юнитом backup.service (см. backup.timer, cron-эквивалент 0 3 * * *) под
# профилем `mws` этой VM (SA anu-live — роль на compute disk-backup
# назначается владельцем вручную, см. RUNBOOK.md).
set -euo pipefail

readonly MWS_PROJECT="project-vxgxs2"
readonly SOURCE_DISK="anu-live-evidence-01"
readonly BACKUP_PREFIX="anu-live-evidence-"
readonly KEEP_LAST=14
TODAY="$(date +%Y%m%d)"
readonly TODAY
readonly BACKUP_NAME="${BACKUP_PREFIX}${TODAY}"

command -v mws >/dev/null 2>&1 || {
  echo "backup.sh: команда mws не найдена в PATH." >&2
  exit 1
}
command -v python3 >/dev/null 2>&1 || {
  echo "backup.sh: python3 не найден в PATH — нечем разобрать список бэкапов." >&2
  exit 1
}

idem_key() {
  # Тот же приём, что и в provision.sh: mws требует настоящий UUID в
  # качестве idempotency-key, а не человекочитаемую строку.
  python3 -c "import uuid,sys; print(uuid.uuid5(uuid.NAMESPACE_URL, sys.argv[1]))" "$1"
}

echo "backup.sh: создаю ${BACKUP_NAME} из диска ${SOURCE_DISK}"
mws compute disk-backup create "compute/projects/${MWS_PROJECT}/diskBackups/${BACKUP_NAME}" \
  --source-disk-id "compute/projects/${MWS_PROJECT}/disks/${SOURCE_DISK}" \
  --os-type LINUX \
  --idempotency-key "$(idem_key "disk-backup-${BACKUP_NAME}")"

echo "backup.sh: прополка копий старше последних ${KEEP_LAST}"

# Обычная mws-пагинация: page-token из ответа -> следующий запрос, пока не
# исчерпан список. Сортировка по времени создания, по убыванию — самые
# новые первыми, чтобы срез "оставить N" был простым срезом списка.
backups_json="$(python3 - "$MWS_PROJECT" "$BACKUP_PREFIX" <<'PYEOF'
import json
import subprocess
import sys

project, prefix = sys.argv[1], sys.argv[2]
items = []
page_token = ""
while True:
    cmd = [
        "mws", "compute", "disk-backup", "list",
        "--project", project,
        "--order-by", "metadata.createTime desc",
        "--page-size", "200",
        "-f", "json",
    ]
    if page_token:
        cmd += ["--page-token", page_token]
    out = subprocess.run(cmd, check=True, capture_output=True, text=True).stdout
    page = json.loads(out) if out.strip() else {}
    for item in page.get("items", page.get("results", [])):
        name = item.get("metadata", {}).get("id", {}).get("name", "")
        if name.startswith(prefix):
            items.append(name)
    page_token = page.get("nextPageToken", "")
    if not page_token:
        break

print(json.dumps(items))
PYEOF
)"

echo "backup.sh: найдено копий с префиксом ${BACKUP_PREFIX}: $(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1])))' "$backups_json")"

to_delete="$(python3 -c "
import json, sys
names = json.loads(sys.argv[1])
keep = int(sys.argv[2])
for name in names[keep:]:
    print(name)
" "$backups_json" "$KEEP_LAST")"

if [[ -z "$to_delete" ]]; then
  echo "backup.sh: копий сверх ${KEEP_LAST} нет — прополка не требуется."
  exit 0
fi

while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  echo "backup.sh: удаляю устаревшую копию ${name}"
  mws compute disk-backup delete "compute/projects/${MWS_PROJECT}/diskBackups/${name}" \
    --purge \
    --idempotency-key "$(idem_key "disk-backup-delete-${name}")"
done <<< "$to_delete"

echo "backup.sh: готово."
