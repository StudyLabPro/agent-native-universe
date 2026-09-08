#!/usr/bin/env bash
#
# deploy/mws/bootstrap-anu-live-1.sh — приводит ГОЛУЮ Ubuntu 24.04 на VM
# anu-live-1 в состояние, которого ожидает compose.live.yml (фаза L5b).
#
# Зачем он существует. deploy/mws/cloud-init.yaml описывает ту же
# настройку, но cloud-init на этой VM НЕ ПРИМЕНЯЛСЯ (ФАКТ, проверено
# 2026-09-08: VM создана в обход провижининга, Docker не установлен),
# а применить cloud-init к уже работающей машине задним числом нельзя.
# Этот скрипт — тот же список действий, выполняемый вручную и
# идемпотентно, МИНУС раздел про отдельный диск улик: диска нет и
# создать его нельзя (квота nbs-pl2 исчерпана), улики живут на
# boot-диске.
#
# Запускается на самой VM от root. Повторный запуск безопасен.
# Ничего не удаляет, ничего не форматирует, ни одного секрета не читает
# и не пишет.
set -euo pipefail

readonly ROOT_DIR="/var/lib/anu-live"
readonly OPT_DIR="/opt/anu-live"
readonly RUN_DIR="/run/anu"
readonly ANU_UID=1000
readonly ANU_GID=1000
# Ниже этого порога свободного места разворачивать вселенную бессмысленно:
# страж диска (--min-free-bytes) поставит её на паузу почти сразу.
readonly MIN_FREE_GIB=20

log() { printf '%s\n' "bootstrap: $*"; }
die() { printf '%s\n' "bootstrap: ОШИБКА: $*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "запускать от root на самой VM anu-live-1."

# --- 1. Кто мы и сколько у нас места -----------------------------------
log "хост $(hostname), $(. /etc/os-release && echo "$PRETTY_NAME"), ядро $(uname -r)"
log "CPU $(nproc), RAM $(awk '/MemTotal/{printf "%.1f GB", $2/1048576}' /proc/meminfo)"

free_gib=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
log "свободно на /: ${free_gib} GB"
if (( free_gib < MIN_FREE_GIB )); then
  die "на / меньше ${MIN_FREE_GIB} GB свободного места — отдельного диска улик нет, разворачивать нечего."
fi

# --- 2. Пользователь uid 1000 ------------------------------------------
# На облачных образах Ubuntu uid 1000 обычно уже занят штатным
# пользователем. Это нормально: контейнерам нужен именно НОМЕР, а не имя.
if existing_user="$(getent passwd "$ANU_UID" | cut -d: -f1)" && [[ -n "$existing_user" ]]; then
  log "uid ${ANU_UID} уже занят пользователем '${existing_user}' — используем его, нового не заводим."
else
  log "создаю системного пользователя anu (uid ${ANU_UID}, без входа в систему)"
  groupadd --gid "$ANU_GID" anu
  useradd --uid "$ANU_UID" --gid "$ANU_GID" --shell /usr/sbin/nologin --no-create-home anu
fi

# --- 3. Docker Engine + compose plugin ---------------------------------
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  log "docker уже установлен: $(docker --version), $(docker compose version --short)"
else
  log "устанавливаю Docker Engine из официального репозитория"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$(dpkg --print-architecture)" "$(. /etc/os-release && echo "$VERSION_CODENAME")" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  log "установлен: $(docker --version), $(docker compose version --short)"
fi

# --- 4. Дерево улик на BOOT-ДИСКЕ --------------------------------------
# Отдельного диска нет, поэтому никакого mkfs и никакой строки в
# /etc/fstab: просто каталоги на корневой файловой системе. Разделение
# на три поддерева не косметическое:
#   evidence/ — корень улик, раннеру rw, Observer'у ro;
#   inbox/    — записанные входы оператора, раннеру ТОЛЬКО ro;
#   gateway/  — аудит и бюджет шлюза, раннер туда не имеет доступа вовсе.
log "создаю дерево ${ROOT_DIR} (владелец ${ANU_UID}:${ANU_GID})"
install -d -m 0755 -o root -g root "$ROOT_DIR"
install -d -m 0750 -o "$ANU_UID" -g "$ANU_GID" "${ROOT_DIR}/evidence"
install -d -m 0755 -o root -g root "${ROOT_DIR}/inbox"
install -d -m 0750 -o "$ANU_UID" -g "$ANU_GID" "${ROOT_DIR}/gateway"
install -d -m 0750 -o "$ANU_UID" -g "$ANU_GID" "${ROOT_DIR}/gateway/audit"
install -d -m 0750 -o "$ANU_UID" -g "$ANU_GID" "${ROOT_DIR}/gateway/state"

# Файлы записанных входов должны существовать до старта: источник читает
# файл целиком на каждом тике, и отсутствующий файл — это не «пусто», а
# сбой чтения. Пишет их оператор (root), раннер читает.
for inbox in tasks verdicts physics; do
  path="${ROOT_DIR}/inbox/${inbox}.jsonl"
  if [[ ! -e "$path" ]]; then
    install -m 0644 -o root -g root /dev/null "$path"
    log "создан пустой ${path}"
  fi
done

# --- 5. Каталог стека --------------------------------------------------
install -d -m 0750 -o root -g root "$OPT_DIR"
install -d -m 0750 -o root -g root /etc/anu-live
log "каталог стека ${OPT_DIR} готов (compose.live.yml, .env, tiers.json кладёт оператор)"

# --- 6. tmpfs для секретов + переживание перезагрузки ------------------
# /run — tmpfs, после перезагрузки он пуст. anu-secrets.service имеет
# ConditionPathExists=/run/anu, то есть без этого каталога он просто
# НЕ ЗАПУСТИТСЯ после ребута и молча оставит стек без секретов.
# systemd-tmpfiles воссоздаёт каталог на каждой загрузке.
install -d -m 0700 -o root -g root "$RUN_DIR"
cat > /etc/tmpfiles.d/anu-live.conf <<'TMPFILES'
# Каталог секретов Genesis-Live в tmpfs. Пересоздаётся на каждой загрузке
# ДО того, как anu-secrets.service проверит своё ConditionPathExists.
d /run/anu 0700 root root -
TMPFILES
systemd-tmpfiles --create /etc/tmpfiles.d/anu-live.conf
log "tmpfs-каталог секретов ${RUN_DIR} создан и объявлен в /etc/tmpfiles.d/anu-live.conf"

# --- 7. Что осталось сделать человеку ----------------------------------
cat <<'NEXT'

bootstrap: машина готова принять стек. Осталось (см. deploy/mws/DEPLOY_LIVE.md):
  1. Владелец: профиль `mws` на этой VM (/root/.config/mws/..., 0600) — без него
     anu-secrets.service не прочитает ни одного секрета.
  2. Владелец: версии трёх секретов в MWS Secret Manager (контейнеры уже созданы,
     значений в них нет) и IAM role bindings для SA anu-live.
  3. Оператор: скопировать в /opt/anu-live — compose.live.yml, .env, tiers.json;
     в /opt/anu-live/anu-secrets.sh — скрипт чтения секретов;
     в /etc/systemd/system — anu-secrets.service, anu-live.service и drop-in
     anu-secrets.service.d/10-before-docker.conf.
  4. Оператор: docker login в registry.mwsapis.ru и `docker compose pull`.
NEXT
