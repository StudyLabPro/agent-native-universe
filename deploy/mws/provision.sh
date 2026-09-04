#!/usr/bin/env bash
#
# deploy/mws/provision.sh — провижининг облачной инфраструктуры MWS для
# постоянного живого инстанса ANU (фаза L5a архитектуры Genesis-Live,
# docs/GENESIS_LIVE.md §7.2).
#
# ЧТО ЭТОТ СКРИПТ ДЕЛАЕТ: создаёт (идемпотентно, где CLI это поддерживает)
# сервисные аккаунты и ключи IAM, пустые контейнеры секретов в Secret
# Manager, сеть/подсеть/внешний адрес/правила firewall в VPC, загрузочный и
# evidence-диски, виртуальную машину anu-live-1 и реестр образов anu.
#
# ЧТО ЭТОТ СКРИПТ НЕ ДЕЛАЕТ: не назначает IAM role bindings (в CLI `mws iam
# role` есть только get/list — привязка ролей делается вручную в консоли
# MWS/REST, см. RUNBOOK.md), не создаёт версии секретов с реальными данными
# (это ручной шаг владельца, см. KEYS.md), не создаёт S3-бакет
# (см. s3-bucket.sh) и не собирает/пушит образ (см. scripts/live/build-push.sh).
#
# ПРЕДОХРАНИТЕЛЬ: каждый вызов ниже создаёт биллингуемый или потенциально
# security-significant реальный ресурс в проекте MWS project-vxgxs2. Условие
# перехода фазы L5a в самом архитектурном документе требует, чтобы владелец
# сначала подтвердил список ресурсов (§10 документа) и лично выполнил шаг с
# секретами и IAM-биндингами. Поэтому скрипт не продолжает работу без явного
# человеческого подтверждения — см. раздел "Предохранитель" ниже.
#
# БЮДЖЕТ (§7.4, только для контекста — логика бюджета живёт не здесь, а в
# шлюзе, уже реализованном в фазе L3b):
#   1. Провайдер: отдельный ключ anu-live-inference, деактивируемый одной
#      командой (см. "Аварийная остановка" в конце файла); квота на
#      ключ/деплой — открытый вопрос к MWS.
#   2. Шлюз: --max-in-flight 24, --rate-per-minute 600, скользящее окно
#      --max-tokens-per-window <решает владелец> на --budget-window-ms
#      86400000 со --state-file. Верхняя граница ≈4.5k токенов/консультацию,
#      ≈145k/тик; типично ≈40k/тик. На эпоху 500 тиков: типично ≈20M,
#      верхняя граница ≈75M токенов — порог окна выбирает владелец от этих
#      чисел.
#   3. Мир: казна treasuryResources.llmTokens = грант в токенах.
#
# ФАКТ, ОБНАРУЖЕННЫЙ ПРИ ПОДГОТОВКЕ ЭТОГО СКРИПТА (2026-09-04): более ранняя
# попытка выполнить часть команд §7.2 для реального проекта project-vxgxs2
# (под профилем xteam-pro, а не выделенным anu-live) провалилась на каждом
# вызове — `vpc network create` и `vpc firewall-rule create` из-за
# нечитаемого mws idempotency-key (сервис требует РЕАЛЬНЫЙ UUID, а не
# произвольную строку вида "anu-live-network-v1"), `vpc firewall-rule create
# .../https-from-lab` из-за приоритета вне допустимого диапазона
# (сервис вернул: "priority has invalid value ... range [1000-64535]" — то
# есть числа 100/105/110/65000 из текста архитектурного документа реальный
# API не примет), а `compute vm create` / `compute disk create` / `vpc
# external-address create` — из-за исчерпанной квоты проекта (vCPU,
# суммарный размер дисков nbs-pl2, внешние адреса). Повторные `get`-проверки
# каждого ресурса вернули 404 — то есть НИ ОДИН ресурс anu-live тогда не был
# реально создан. Из этого учтено ниже: idempotency-key генерируется как
# настоящий UUID (idem_key), приоритеты firewall смещены в допустимый
# диапазон (см. комментарий в разделе VPC), а перед первым реальным запуском
# нужно свериться с квотами проекта в консоли/поддержке MWS — это отдельно
# отмечено в RUNBOOK.md.
set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Константы
# ---------------------------------------------------------------------------
readonly MWS_PROJECT="project-vxgxs2"
readonly MWS_ZONE="ru-central1-a"
readonly LAB_IP="185.233.3.14"
readonly CONFIRM_FLAG="--yes-i-understand-this-costs-real-money"
# Фиксированное пространство имён для детерминированных UUIDv5 idempotency-key.
# Значение произвольно, но должно оставаться неизменным между запусками —
# от него зависит, распознает ли MWS повторный запуск той же команды как
# идемпотентный повтор, а не новый запрос.
readonly IDEM_NAMESPACE="a26e9d3e-9f9a-4c9b-8f38-8a6a2e5b6a11"

# ---------------------------------------------------------------------------
# 1. Обязательный параметр оператора: IP владельца для SSH-правила firewall
# ---------------------------------------------------------------------------
: "${OWNER_SSH_IP:?$(cat <<'EOF'
Ошибка: переменная окружения OWNER_SSH_IP не задана.

Правило firewall ssh-from-owner (§7.2) требует IP-адрес владельца в качестве
источника. Задайте его перед запуском, например:

  OWNER_SSH_IP=203.0.113.7 ./deploy/mws/provision.sh

Скрипт остановлен до создания каких-либо ресурсов.
EOF
)}"

# ---------------------------------------------------------------------------
# 2. Вспомогательные функции
# ---------------------------------------------------------------------------
section() { printf '\n=== %s ===\n' "$1"; }
step()    { printf -- '--- %s\n' "$1"; }

# Детерминированный UUIDv5 из строки-описания ресурса. Реальный MWS API
# отклоняет idempotency-key, который не парсится как UUID (см. заголовок
# файла) — человекочитаемые слаги здесь недопустимы.
idem_key() {
  local seed="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import uuid,sys; print(uuid.uuid5(uuid.UUID(sys.argv[1]), sys.argv[2]))" \
      "$IDEM_NAMESPACE" "$seed"
  elif command -v uuidgen >/dev/null 2>&1; then
    uuidgen --sha1 -n @url -N "$seed"
  else
    echo "Ошибка: не найден ни python3, ни uuidgen — нечем построить детерминированный idempotency-key." >&2
    exit 1
  fi
}

# Печатает команду перед выполнением — чтобы при реальном запуске оператор
# видел в логе именно то, что уходит в API, до получения ответа.
run() {
  printf '$ %s\n' "$*"
  "$@"
}

# Паттерн "--validate-only, затем реальный вызов" — только для ресурсов, у
# которых флаг --validate-only реально существует И которые архитектурный
# документ прямо просит проверять так: vpc network/subnet/firewall-rule.
# ВНИМАНИЕ: документ просил включить сюда ещё и `compute vm create`, но
# `mws compute vm create --help` (сверено 2026-09-04) такого флага не
# показывает вовсе — раздел 5 ниже создаёт VM одним прямым вызовом и это
# явно откомментировано на месте.
create_validated() {
  local desc="$1" seed="$2"
  shift 2
  step "${desc}: dry-run (--validate-only)"
  run "$@" --validate-only --idempotency-key "$(idem_key "${seed}-validate")"
  step "${desc}: создание"
  run "$@" --idempotency-key "$(idem_key "${seed}")"
}

# ---------------------------------------------------------------------------
# 3. Предохранитель: явное человеческое подтверждение
# ---------------------------------------------------------------------------
command -v mws >/dev/null 2>&1 || {
  echo "Ошибка: команда mws не найдена в PATH." >&2
  exit 1
}

ASSUME_YES=0
for arg in "$@"; do
  if [[ "$arg" == "$CONFIRM_FLAG" ]]; then
    ASSUME_YES=1
  fi
done

section "Предохранитель: провижининг реальной инфраструктуры MWS"
cat <<EOF
Этот запуск создаст в проекте MWS ${MWS_PROJECT} (зона ${MWS_ZONE}) реальные,
БИЛЛИНГУЕМЫЕ и/или security-significant ресурсы:

  IAM:      сервисные аккаунты anu-live, anu-site-ask, anu-anchor;
            API-ключ anu-live-inference, API-ключ ask-lab, HMAC-ключ anchors,
            authorized key vm-anu-live-1.
  Secret Manager: пустые секреты anu-live-provider-key, anu-live-gateway-token,
            anu-live-observer-token (без данных — данные создаёт владелец).
  VPC:      сеть anu-live, подсеть anu-live-nodes, внешний адрес
            anu-live-1-ip, правила firewall https-from-lab / acme-http /
            ssh-from-owner / deny-all-ingress.
  Compute:  диски anu-live-1-boot (50GB) и anu-live-evidence-01 (300GB,
            nbs-pl2), виртуальная машина anu-live-1 (base-8-32).
  Registry: реестр anu и репозиторий agent-native-universe-lab.

Условие перехода фазы L5a (docs/GENESIS_LIVE.md): владелец ПОДТВЕРДИЛ список
ресурсов и лично выполняет последующий шаг с секретами и IAM-биндингами (его
CLI не умеет — только консоль/REST). Прежде чем продолжать, проверьте в
консоли/поддержке MWS квоты проекта: более ранняя попытка (см. заголовок
файла) упёрлась в исчерпанные vCPU, суммарный размер дисков nbs-pl2 и
external address — без запаса по квоте реальные вызовы ниже провалятся.

Ни один из вызовов ниже не выполняется, пока вы явно не подтвердите запуск.
EOF

if [[ "$ASSUME_YES" -eq 1 ]]; then
  echo "Флаг ${CONFIRM_FLAG} передан — пропускаю интерактивный вопрос."
else
  if [[ ! -t 0 ]]; then
    echo "Отказ: нет ни флага ${CONFIRM_FLAG}, ни интерактивного терминала для подтверждения. Ни один ресурс не создан." >&2
    exit 1
  fi
  read -r -p "Продолжить и создать перечисленные выше реальные ресурсы? [y/N] " REPLY
  case "$REPLY" in
    y|Y|yes|Yes|YES) ;;
    *)
      echo "Остановлено оператором. Ни один ресурс не создан." >&2
      exit 1
      ;;
  esac
fi

step "Текущий профиль mws (проверьте, что это ожидаемый субъект)"
run mws profile get -f json || true

# ===========================================================================
# 4. IAM — сервисные аккаунты и ключи (§7.2)
# ===========================================================================
section "IAM: сервисные аккаунты и ключи"

# `mws iam service-account create --help` не показывает флаг
# --idempotency-key вовсе — не передаём его сюда (в отличие от api-key /
# hmac-key / authorized-key create, где флаг есть и подтверждён).
run mws iam service-account create "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live" \
  --display-name anu-live

run mws iam api-key create "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live/apiKeys/anu-live-inference" \
  --service-account "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live" \
  --expiration-time 2027-03-01T00:00:00Z --active \
  --idempotency-key "$(idem_key 'apikey-anu-live-inference')"

run mws iam service-account create "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-site-ask" \
  --display-name anu-site-ask

# Замена ключа сайта studylabpro.com (SA xteam-pro), который истекает
# 2026-11-22 — см. KEYS.md.
run mws iam api-key create "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-site-ask/apiKeys/ask-lab" \
  --service-account "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-site-ask" \
  --expiration-time 2027-03-01T00:00:00Z --active \
  --idempotency-key "$(idem_key 'apikey-ask-lab')"

run mws iam service-account create "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-anchor" \
  --display-name anu-anchor

run mws iam hmac-key create "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-anchor/hmacKeys/anchors" \
  --service-account "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-anchor" \
  --expiration-time 2027-03-01T00:00:00Z \
  --idempotency-key "$(idem_key 'hmackey-anchors')"

# ES256; keyId без префикса iam/, ключи base64 DER. Этот authorized key
# устанавливается на VM как профиль `mws` (см. cloud-init.yaml) — там же
# `mws init` с приватной частью, которую CLI вернёт в status.privateKey
# ОДИН РАЗ при создании. Скрипт эту приватную часть никуда не пишет и не
# логирует — она уходит только в stdout самой команды mws на усмотрение
# оператора.
run mws iam authorized-key create "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live/authorizedKeys/vm-anu-live-1" \
  --service-account "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live" \
  --expiration-time 2027-03-01T00:00:00Z \
  --idempotency-key "$(idem_key 'authorizedkey-vm-anu-live-1')"

cat <<EOF

СЛЕДУЮЩИЙ ШАГ — РУЧНОЙ, ТОЛЬКО ВЛАДЕЛЕЦ:
IAM role bindings в CLI НЕДОСТУПНЫ (mws iam role = get/list). Назначьте в
консоли MWS/REST:
  anu-live   → чтение секретов anu-live-*, pull из registry anu,
               compute disk-backup на диск anu-live-evidence-01
  anu-anchor → запись в S3 anu-live-anchors (и только туда)

После назначения биндингов (и после того, как соответствующие ресурсы
из разделов ниже реально существуют) проверьте их вручную — ни одна из
следующих команд не выполняется этим скриптом:

  mws --impersonate iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live \\
      secretmanager secret-version get-data --name anu-live-provider-key -f json

  # docker pull из реестра anu под профилем VM (см. cloud-init.yaml, anu-secrets.service)

  mws --impersonate iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live \\
      compute disk-backup list -f json
  # (create — только по реальному расписанию backup.timer, не как проверка)

  # S3-запись в anu-live-anchors под HMAC-ключом anchors — см. s3-bucket.sh
EOF

# ===========================================================================
# 5. Secret Manager — пустые контейнеры секретов (§7.2, §7.3)
# ===========================================================================
section "Secret Manager: пустые секреты (данные создаёт владелец вручную)"

run mws secretmanager secret create "secretmanager/projects/${MWS_PROJECT}/secrets/anu-live-provider-key" \
  --active --description 'MWS GPT key for Genesis-Live gateway' \
  --idempotency-key "$(idem_key 'secret-anu-live-provider-key')"

run mws secretmanager secret create "secretmanager/projects/${MWS_PROJECT}/secrets/anu-live-gateway-token" \
  --active \
  --idempotency-key "$(idem_key 'secret-anu-live-gateway-token')"

run mws secretmanager secret create "secretmanager/projects/${MWS_PROJECT}/secrets/anu-live-observer-token" \
  --active \
  --idempotency-key "$(idem_key 'secret-anu-live-observer-token')"

cat <<'EOF'

Секреты созданы как ПУСТЫЕ контейнеры. Версии с реальными данными создаёт
только владелец вручную (см. KEYS.md и §7.3) — этот скрипт не содержит и не
может содержать значения секретов.
EOF

# ===========================================================================
# 6. VPC — сеть, подсеть, внешний адрес, firewall (§7.2)
# ===========================================================================
section "VPC: сеть, подсеть, внешний адрес, firewall"

create_validated "Сеть anu-live" "network-anu-live" \
  mws vpc network create "vpc/projects/${MWS_PROJECT}/networks/anu-live" \
  --internet-access

create_validated "Подсеть anu-live-nodes" "subnet-anu-live-nodes" \
  mws vpc subnet create "vpc/projects/${MWS_PROJECT}/networks/anu-live/subnets/anu-live-nodes" \
  --network anu-live --cidr 10.77.0.0/24

# --validate-only у external-address существует, но архитектурный документ
# не просил проверять его так (список --validate-only ограничен
# network/subnet/firewall-rule/vm) — создаём одним вызовом.
run mws vpc external-address create "vpc/projects/${MWS_PROJECT}/externalAddresses/anu-live-1-ip" \
  --idempotency-key "$(idem_key 'external-address-anu-live-1-ip')"

# ВНИМАНИЕ — приоритеты ниже НЕ совпадают с числами в тексте архитектурного
# документа (100/105/110/65000). Реальный `mws vpc firewall-rule create`
# отклонил приоритет 100 при попытке 2026-09-04: "priority has invalid
# value ... range [1000-64535]". Порядок точно тот же, шкала сдвинута в
# допустимый диапазон:
#   https-from-lab     100   -> 1000
#   acme-http          105   -> 1005
#   ssh-from-owner     110   -> 1010
#   deny-all-ingress 65000   -> 64535 (максимум допустимого диапазона)
create_validated "Firewall https-from-lab" "firewall-https-from-lab" \
  mws vpc firewall-rule create "vpc/projects/${MWS_PROJECT}/networks/anu-live/firewallRules/https-from-lab" \
  --network anu-live --direction INGRESS --action ALLOW --priority 1000 \
  --proto-ports tcp:443 \
  --source-spec-cidrs "${LAB_IP}/32" \
  --destination-spec-cidrs 10.77.0.10/32 --active

# Только ACME (caddy :80 без редиректов и без проксирования какого-либо
# другого пути — см. caddy/Caddyfile).
create_validated "Firewall acme-http" "firewall-acme-http" \
  mws vpc firewall-rule create "vpc/projects/${MWS_PROJECT}/networks/anu-live/firewallRules/acme-http" \
  --network anu-live --direction INGRESS --action ALLOW --priority 1005 \
  --proto-ports tcp:80 \
  --source-spec-cidrs 0.0.0.0/0 \
  --destination-spec-cidrs 10.77.0.10/32 --active

create_validated "Firewall ssh-from-owner" "firewall-ssh-from-owner" \
  mws vpc firewall-rule create "vpc/projects/${MWS_PROJECT}/networks/anu-live/firewallRules/ssh-from-owner" \
  --network anu-live --direction INGRESS --action ALLOW --priority 1010 \
  --proto-ports tcp:22 \
  --source-spec-cidrs "${OWNER_SSH_IP}/32" \
  --source-spec-cidrs "${LAB_IP}/32" \
  --destination-spec-cidrs 10.77.0.10/32 --active

create_validated "Firewall deny-all-ingress" "firewall-deny-all-ingress" \
  mws vpc firewall-rule create "vpc/projects/${MWS_PROJECT}/networks/anu-live/firewallRules/deny-all-ingress" \
  --network anu-live --direction INGRESS --action DENY --priority 64535 \
  --source-spec-cidrs 0.0.0.0/0 \
  --destination-spec-cidrs 10.77.0.0/24 --active

echo "tcp/7400 intra-subnet — только со вторым узлом (L8/P9, не сейчас) — правило намеренно не создаётся."

# ===========================================================================
# 7. Диски и виртуальная машина (§7.2)
# ===========================================================================
section "Compute: диски и виртуальная машина anu-live-1"

run mws compute disk create "compute/projects/${MWS_PROJECT}/disks/anu-live-1-boot" \
  --zone "${MWS_ZONE}" --size 50GB --os-type LINUX \
  --disk-type compute/diskTypes/nbs-pl2 \
  --source-image compute/projects/mws-ubuntu/images/mws-ubuntu-2404-lts-v20260324 \
  --idempotency-key "$(idem_key 'disk-anu-live-1-boot')"

run mws compute disk create "compute/projects/${MWS_PROJECT}/disks/anu-live-evidence-01" \
  --zone "${MWS_ZONE}" --size 300GB --disk-type compute/diskTypes/nbs-pl2 --iops 3000 \
  --idempotency-key "$(idem_key 'disk-anu-live-evidence-01')"

# ВНИМАНИЕ: архитектурный документ просил обернуть эту команду в
# --validate-only так же, как сеть/подсеть/firewall выше. `mws compute vm
# create --help` (сверено 2026-09-04; реальное имя подкоманды —
# `compute virtual-machine create`, `vm` работает как алиас) такого флага
# не показывает вовсе — вызов с --validate-only здесь завершился бы ошибкой
# "unknown flag". Создаём одним прямым вызовом с --idempotency-key (флаг
# этот у VM есть и подтверждён).
run mws compute vm create "compute/projects/${MWS_PROJECT}/virtualMachines/anu-live-1" \
  --zone "${MWS_ZONE}" --vm-type compute/vmTypes/base-8-32 \
  --service-account "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live" \
  --os-hostname anu-live-1 \
  --os-metadata-attributes @deploy/mws/cloud-init.yaml \
  --storage-disks 'boot: true, deviceName: boot, disk: {ref: "compute/projects/'"${MWS_PROJECT}"'/disks/anu-live-1-boot"}' \
  --storage-disks 'boot: false, deviceName: evidence, disk: {ref: "compute/projects/'"${MWS_PROJECT}"'/disks/anu-live-evidence-01"}' \
  --network-interfaces 'primary: true, name: eth0, addresses: [{address: {spec: {subnet: "vpc/projects/'"${MWS_PROJECT}"'/networks/anu-live/subnets/anu-live-nodes", ipAddress: 10.77.0.10}}, oneToOneNat: {external: {address: {ref: "vpc/projects/'"${MWS_PROJECT}"'/externalAddresses/anu-live-1-ip"}}}}]' \
  --idempotency-key "$(idem_key 'vm-anu-live-1')"

cat <<'EOF'

НЕПРОВЕРЕННЫЙ ФАКТ (см. docs/GENESIS_LIVE.md §8 "Operational facts to record
at first launch"): формат значения --os-metadata-attributes для передачи
cloud-init.yaml (ожидается ли ключ user-data внутри YAML-структуры или файл
интерпретируется как cloud-init напрямую) — сверить при первом реальном
запуске и вписать сюда/в docs/GENESIS_LIVE.md результат.
EOF

# ===========================================================================
# 8. Реестр образов (§7.2)
# ===========================================================================
section "Registry: реестр anu и репозиторий agent-native-universe-lab"

# `mws registry registry create --help` и `mws registry repository create
# --help` не показывают ни --validate-only, ни --idempotency-key — прямые
# вызовы без этих флагов, как и предполагает архитектурный документ.
run mws registry registry create "registry/projects/${MWS_PROJECT}/registries/anu" \
  --ip-filter-mode WHITELIST --ip-filter-operations PUSH \
  --ip-filter-source-ip-cidr-ranges "${LAB_IP}/32"

run mws registry repository create "registry/projects/${MWS_PROJECT}/registries/anu/repositories/agent-native-universe-lab" \
  --registry anu

run mws registry configure-docker

echo "Реестр и репозиторий созданы. Сборка и push образа — scripts/live/build-push.sh (запускается отдельно, не отсюда)."

# ===========================================================================
# 9. Напоминание: DNS (ручной шаг, выполняется отдельно от этого скрипта)
# ===========================================================================
section "DNS (напоминание — выполняется отдельно, не этим скриптом)"
cat <<'EOF'
Когда внешний адрес anu-live-1-ip получит значение, добавьте A-запись:

  xt-plesk dns-add studylabpro.com A live.anu <external-ip>

(ns1/ns2.studylabpro.com -> 5.101.77.36). Публикация DNS-записи — необратимое
публичное действие (домен станет виден всем), поэтому эта команда намеренно
НЕ выполняется автоматически этим скриптом.
EOF

# ===========================================================================
# 10. Напоминание: резервное копирование (настраивается отдельно)
# ===========================================================================
section "Backup (напоминание — настраивается через deploy/mws/backup.timer на VM)"
cat <<'EOF'
Ежедневный disk-backup (cron 0 3 * * *, хранить 14 последних копий) настроен
не здесь, а systemd-таймером на самой VM — см. deploy/mws/backup.timer,
deploy/mws/backup.service и deploy/mws/backup.sh. Этот скрипт таймер не
устанавливает (он живёт на VM, которая ещё не существует до раздела 7 выше).
EOF

# ===========================================================================
# 11. Напоминание: аварийная остановка мышления
# ===========================================================================
section "Аварийная остановка (напоминание — НЕ выполняется автоматически)"
cat <<EOF
Остановка, не зависящая от процесса шлюза/супервизора — деактивация ключа
провайдера. Супервизор (anu lab live, фаза L3c) поставит вселенную на паузу
на границе тика после исчерпания --outage-ticks, как только провайдер
перестанет отвечать:

  mws iam api-key update "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live/apiKeys/anu-live-inference" --active=false

См. RUNBOOK.md — там же обратная команда (--active) и что при этом
происходит с уже идущей вселенной.
EOF

section "Готово"
echo "Провижининг из §7.2 завершён. Дальнейшие шаги (роли, секреты, DNS, S3, образ) — см. RUNBOOK.md."
