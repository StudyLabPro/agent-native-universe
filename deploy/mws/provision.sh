#!/usr/bin/env bash
#
# deploy/mws/provision.sh — провижининг облачной инфраструктуры MWS для
# постоянного живого инстанса ANU (фаза L5a архитектуры Genesis-Live,
# docs/GENESIS_LIVE.md §7.2).
#
# ФАКТ (2026-09-06): бо́льшая часть ресурсов ниже уже существует в реальном
# аккаунте — их создал более ранний запуск 2026-09-04 01:39–01:56 в обход
# предохранителя этого скрипта (см. RUNBOOK.md, раздел "Инцидент
# 2026-09-04"). Проверено напрямую через `mws ... list -f json` 2026-09-06:
#   УЖЕ ЕСТЬ: SA anu-live/anu-site-ask/anu-anchor; сеть anu-live + подсеть
#   anu-live-nodes; диск anu-live-1-boot; VM anu-live-1 (РАБОТАЕТ, power ON,
#   но как base-4-8, не base-8-32 — квота vCPU не позволила; собственное
#   описание VM в API так и гласит: "Interim type base-4-8 until vCPU quota
#   allows base-8-32"); правила firewall https-from-lab / acme-http /
#   deny-all-ingress (значения совпадают с §7.2 по факту, хотя приоритеты
#   отличаются от чисел в тексте архитектурного документа — см. ниже) и
#   ssh-from-lab (совпадает с §7.2 по имени и структуре, НО пускает только
#   Lab — IP владельца в нём нет, документ называл эту роль
#   "ssh-from-owner"); реестр anu + репозиторий agent-native-universe-lab.
#   ЧЕГО НЕТ: ни одного IAM-ключа (api-key/hmac-key/authorized-key), ни
#   одного секрета в Secret Manager, external-address anu-live-1-ip, диска
#   anu-live-evidence-01 (300GB) — то есть VM работает голая, без данных,
#   без ключей и без доступа снаружи.
# Поэтому этот скрипт больше не пишет прямые `create` без проверки — каждый
# ресурс сначала проверяется через `get` (exit 0 = уже есть, exit 1 = 404 =
# нет) и создаётся только если отсутствует. Так его можно безопасно
# перезапускать сколько угодно раз, включая уже частично провизионированный
# аккаунт вроде текущего.
#
# ЧТО ЭТОТ СКРИПТ ДЕЛАЕТ: доводит IAM/Secret Manager/VPC/диски/реестр до
# состояния §7.2 везде, где это НЕ требует трогать уже работающую VM.
#
# ЧТО ЭТОТ СКРИПТ НЕ ДЕЛАЕТ: не назначает IAM role bindings (в CLI `mws iam
# role` есть только get/list — вручную, см. RUNBOOK.md), не создаёт версии
# секретов с реальными данными (ручной шаг владельца, см. KEYS.md), не
# создаёт S3-бакет (см. s3-bucket.sh), не собирает/пушит образ (см.
# scripts/live/build-push.sh) и — специально — НЕ подключает новый
# evidence-диск и внешний адрес к уже работающей VM anu-live-1 автоматически:
# `mws compute vm update --storage-disks/--network-interfaces` по тексту
# `--help` выглядит как полная замена списка (тот же repeatable-flag
# паттерн, что и в `create`), а не слияние. Собрать это неверно на живой VM
# значит рискнуть отключить её текущий boot-диск или сеть. Этот шаг скрипт
# только печатает как явную ручную инструкцию в конце (раздел 8) —
# реконструированную из СВЕЖЕГО `vm get`, а не из значений на момент
# написания этого файла.
#
# ПРЕДОХРАНИТЕЛЬ: каждый вызов ниже, который реально что-то создаёт —
# биллингуемый или security-significant ресурс в проекте MWS
# ${MWS_PROJECT}. Условие перехода фазы L5a в архитектурном документе
# требует, чтобы владелец сначала подтвердил список ресурсов и лично
# выполнил шаг с секретами и IAM-биндингами. Скрипт не продолжает работу без
# явного человеческого подтверждения — см. раздел "Предохранитель" ниже.
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
# ФАКТ, ОБНАРУЖЕННЫЙ ПРИ ПОДГОТОВКЕ ПЕРВОЙ ВЕРСИИ ЭТОГО СКРИПТА (2026-09-04,
# из логов неудачной части попытки 01:39–01:54, до того как выяснилось, что
# другая часть той же попытки реально успела создать ресурсы выше): реальный
# API отклоняет idempotency-key, который не парсится как UUID (человекочит-
# аемые слаги вида "anu-live-network-v1" не годятся), и требует приоритет
# firewall-правила в диапазоне [1000-64535], а не произвольное 100/65000 из
# текста документа. Учтено ниже: idempotency-key — настоящий UUIDv5,
# приоритеты новых правил (если когда-либо понадобится создавать их с нуля)
# смещены в допустимый диапазон.
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

# ---------------------------------------------------------------------------
# 0. Константы
# ---------------------------------------------------------------------------
readonly MWS_PROJECT="${MWS_PROJECT:?MWS_PROJECT не задан: заполните deploy/mws/target.env по образцу target.env.example}"
readonly MWS_ZONE="ru-central1-a"
readonly LAB_IP="${ANU_LIVE_LAB_IP:?ANU_LIVE_LAB_IP не задан: заполните deploy/mws/target.env}"
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

Правило firewall ssh-from-lab (де-факто исполняющее роль ssh-from-owner из
§7.2) должно включать IP-адрес владельца как дополнительный источник.
Задайте его перед запуском, например:

  OWNER_SSH_IP=203.0.113.7 ./deploy/mws/provision.sh

Скрипт остановлен до создания/изменения каких-либо ресурсов.
EOF
)}"

# ---------------------------------------------------------------------------
# 2. Вспомогательные функции
# ---------------------------------------------------------------------------
section() { printf '\n=== %s ===\n' "$1"; }
step()    { printf -- '--- %s\n' "$1"; }

# Детерминированный UUIDv5 из строки-описания ресурса. Реальный MWS API
# отклоняет idempotency-key, который не парсится как UUID — человекочитаемые
# слаги здесь недопустимы.
idem_key() {
  local seed="$1"
  python3 -c "import uuid,sys; print(uuid.uuid5(uuid.UUID(sys.argv[1]), sys.argv[2]))" \
    "$IDEM_NAMESPACE" "$seed"
}

# Печатает команду перед выполнением — чтобы при реальном запуске оператор
# видел в логе именно то, что уходит в API, до получения ответа.
run() {
  printf '$ %s\n' "$*"
  "$@"
}

# Есть ли уже ресурс? Использует то, что `mws <group> <resource> get <id>`
# возвращает exit 0, если ресурс существует, и exit 1 (404) если нет —
# проверено напрямую 2026-09-06 на всех типах ресурсов, использованных ниже.
exists() {
  "$@" >/dev/null 2>&1
}

# Обёртка "проверить — и только если нет, создать": печатает, что произошло,
# в обоих случаях, чтобы лог запуска был читаем без сверки с консолью.
ensure() {
  local desc="$1"; shift
  local i
  # Вызывающий код передаёт get-команду и create-команду, разделённые
  # литералом "--".
  local args=("$@")
  local sep_idx=-1
  for i in "${!args[@]}"; do
    if [[ "${args[$i]}" == "--" ]]; then sep_idx=$i; break; fi
  done
  if [[ $sep_idx -lt 0 ]]; then
    echo "Ошибка программирования: ensure() без разделителя '--' между get и create." >&2
    exit 1
  fi
  local get_full=("${args[@]:0:$sep_idx}")
  local create_full=("${args[@]:$((sep_idx+1))}")
  if exists "${get_full[@]}"; then
    step "${desc}: уже существует — пропускаю создание"
  else
    step "${desc}: не найден — создаю"
    run "${create_full[@]}"
  fi
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

section "Предохранитель: провижининг/донастройка реальной инфраструктуры MWS"
cat <<EOF
Этот запуск проверит состояние проекта MWS ${MWS_PROJECT} (зона ${MWS_ZONE})
и создаст только то, чего там ЕЩЁ НЕТ (см. факт-раздел в заголовке файла):

  IAM:      API-ключ anu-live-inference, API-ключ ask-lab, HMAC-ключ anchors,
            authorized key vm-anu-live-1 (сервисные аккаунты anu-live /
            anu-site-ask / anu-anchor уже существуют — не трогаются).
  Secret Manager: пустые секреты anu-live-provider-key, anu-live-gateway-token,
            anu-live-observer-token (без данных — данные создаёт владелец).
  VPC:      внешний адрес anu-live-1-ip (сеть/подсеть/большинство правил
            firewall уже существуют); правило ssh-from-lab будет ДОПОЛНЕНО
            вашим IP, если его там ещё нет — существующий доступ с Lab
            (Lab) не убирается.
  Compute:  диск anu-live-evidence-01 (300GB, nbs-pl2). VM anu-live-1 УЖЕ
            РАБОТАЕТ (base-4-8) — этот скрипт её не создаёт и не меняет;
            подключение нового диска и внешнего адреса к ней — отдельный
            ручной шаг, который скрипт только опишет в конце (раздел 8).
  Registry: реестр anu и репозиторий agent-native-universe-lab уже
            существуют — не трогаются.

Прежде чем продолжать, проверьте в консоли/поддержке MWS квоты проекта:
VM anu-live-1 уже работает как base-4-8 именно из-за нехватки квоты на
base-8-32 — новый диск на 300GB тоже посчитается в квоту дисков.

Ни один из вызовов ниже не создаёт и не меняет ресурс, пока вы явно не
подтвердите запуск.
EOF

if [[ "$ASSUME_YES" -eq 1 ]]; then
  echo "Флаг ${CONFIRM_FLAG} передан — пропускаю интерактивный вопрос."
else
  if [[ ! -t 0 ]]; then
    echo "Отказ: нет ни флага ${CONFIRM_FLAG}, ни интерактивного терминала для подтверждения. Ничего не создано и не изменено." >&2
    exit 1
  fi
  read -r -p "Продолжить и создать/дополнить перечисленное выше? [y/N] " REPLY
  case "$REPLY" in
    y|Y|yes|Yes|YES) ;;
    *)
      echo "Остановлено оператором. Ничего не создано и не изменено." >&2
      exit 1
      ;;
  esac
fi

step "Текущий активный профиль mws (проверьте, что это ожидаемый субъект)"
run mws profile current -f json || true

# ===========================================================================
# 4. IAM — сервисные аккаунты (проверка) и ключи (§7.2)
# ===========================================================================
section "IAM: сервисные аккаунты (проверка) и ключи (создание недостающих)"

ensure "SA anu-live" \
  mws iam service-account get "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live" -- \
  mws iam service-account create "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live" \
  --display-name anu-live

ensure "API-ключ anu-live-inference" \
  mws iam api-key get "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live/apiKeys/anu-live-inference" -- \
  mws iam api-key create "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live/apiKeys/anu-live-inference" \
  --service-account "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live" \
  --expiration-time 2027-03-01T00:00:00Z --active \
  --idempotency-key "$(idem_key 'apikey-anu-live-inference')"

ensure "SA anu-site-ask" \
  mws iam service-account get "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-site-ask" -- \
  mws iam service-account create "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-site-ask" \
  --display-name anu-site-ask

# Замена ключа инференса витрины Ask Lab на собственный SA — см. KEYS.md.
# Актуальный срок истечения текущего ключа даёт `iam api-key get`.
ensure "API-ключ ask-lab" \
  mws iam api-key get "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-site-ask/apiKeys/ask-lab" -- \
  mws iam api-key create "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-site-ask/apiKeys/ask-lab" \
  --service-account "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-site-ask" \
  --expiration-time 2027-03-01T00:00:00Z --active \
  --idempotency-key "$(idem_key 'apikey-ask-lab')"

ensure "SA anu-anchor" \
  mws iam service-account get "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-anchor" -- \
  mws iam service-account create "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-anchor" \
  --display-name anu-anchor

ensure "HMAC-ключ anchors" \
  mws iam hmac-key get "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-anchor/hmacKeys/anchors" -- \
  mws iam hmac-key create "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-anchor/hmacKeys/anchors" \
  --service-account "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-anchor" \
  --expiration-time 2027-03-01T00:00:00Z \
  --idempotency-key "$(idem_key 'hmackey-anchors')"

# ES256; keyId без префикса iam/, ключи base64 DER. Этот authorized key
# устанавливается на VM как профиль `mws` (см. cloud-init.yaml) — там же
# `mws init` с приватной частью, которую CLI вернёт в status.privateKey
# ОДИН РАЗ при создании. Скрипт эту приватную часть никуда не пишет и не
# логирует — она уходит только в stdout самой команды mws на усмотрение
# оператора.
# `--key-algorithm` не заполняется по умолчанию — реальный API 2026-09-06
# отклонил вызов без него (`keyAlgorithm has invalid value ... not in list
# [ES256]`), хотя в --help это выглядело необязательным. ES256 — то же
# значение, что уже предполагал заголовок этого файла и cloud-init.yaml.
ensure "Authorized key vm-anu-live-1" \
  mws iam authorized-key get "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live/authorizedKeys/vm-anu-live-1" -- \
  mws iam authorized-key create "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live/authorizedKeys/vm-anu-live-1" \
  --service-account "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live" \
  --key-algorithm ES256 \
  --expiration-time 2027-03-01T00:00:00Z \
  --idempotency-key "$(idem_key 'authorizedkey-vm-anu-live-1')"

cat <<EOF

СЛЕДУЮЩИЙ ШАГ — РУЧНОЙ, ТОЛЬКО ВЛАДЕЛЕЦ:
IAM role bindings в CLI НЕДОСТУПНЫ (mws iam role = get/list). Назначьте в
консоли MWS/REST:
  anu-live   → чтение секретов anu-live-*, pull из registry anu,
               compute disk-backup на диск anu-live-evidence-01
  anu-anchor → запись в S3 anu-live-anchors (и только туда)

После назначения биндингов проверьте их вручную — ни одна из следующих
команд не выполняется этим скриптом:

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
section "Secret Manager: пустые секреты (создание недостающих; данные — вручную владельцем)"

ensure "Секрет anu-live-provider-key" \
  mws secretmanager secret get "secretmanager/projects/${MWS_PROJECT}/secrets/anu-live-provider-key" -- \
  mws secretmanager secret create "secretmanager/projects/${MWS_PROJECT}/secrets/anu-live-provider-key" \
  --active --description 'MWS GPT key for Genesis-Live gateway' \
  --idempotency-key "$(idem_key 'secret-anu-live-provider-key')"

ensure "Секрет anu-live-gateway-token" \
  mws secretmanager secret get "secretmanager/projects/${MWS_PROJECT}/secrets/anu-live-gateway-token" -- \
  mws secretmanager secret create "secretmanager/projects/${MWS_PROJECT}/secrets/anu-live-gateway-token" \
  --active \
  --idempotency-key "$(idem_key 'secret-anu-live-gateway-token')"

ensure "Секрет anu-live-observer-token" \
  mws secretmanager secret get "secretmanager/projects/${MWS_PROJECT}/secrets/anu-live-observer-token" -- \
  mws secretmanager secret create "secretmanager/projects/${MWS_PROJECT}/secrets/anu-live-observer-token" \
  --active \
  --idempotency-key "$(idem_key 'secret-anu-live-observer-token')"

cat <<'EOF'

Секреты — только ПУСТЫЕ контейнеры. Версии с реальными данными создаёт
только владелец вручную (см. KEYS.md и §7.3) — этот скрипт не содержит и не
может содержать значения секретов.
EOF

# ===========================================================================
# 6. VPC — сеть/подсеть (проверка), внешний адрес (создание), firewall (§7.2)
# ===========================================================================
section "VPC: сеть/подсеть (проверка), внешний адрес (создание), firewall (проверка + донастройка SSH)"

ensure "Сеть anu-live" \
  mws vpc network get "vpc/projects/${MWS_PROJECT}/networks/anu-live" -- \
  mws vpc network create "vpc/projects/${MWS_PROJECT}/networks/anu-live" --internet-access \
  --idempotency-key "$(idem_key 'network-anu-live')"

ensure "Подсеть anu-live-nodes" \
  mws vpc subnet get "vpc/projects/${MWS_PROJECT}/networks/anu-live/subnets/anu-live-nodes" -- \
  mws vpc subnet create "vpc/projects/${MWS_PROJECT}/networks/anu-live/subnets/anu-live-nodes" \
  --network anu-live --cidr "${ANU_LIVE_SUBNET_CIDR:?ANU_LIVE_SUBNET_CIDR не задан: заполните deploy/mws/target.env}" \
  --idempotency-key "$(idem_key 'subnet-anu-live-nodes')"

# Реальный API 2026-09-06 отклонил вызов без --body (`415 Content type ''
# not supported` — CLI не ставит Content-Type для буквально пустого тела), а
# затем `--body '{}'` (`required field is not filled: spec`). Ни одна из
# этих двух попыток ничего не создала (обе провалились до записи). Рабочая
# гипотеза, ПОКА НЕ ПРОВЕРЕННАЯ реальным запуском — пустой, но
# присутствующий объект spec:
ensure "Внешний адрес anu-live-1-ip" \
  mws vpc external-address get "vpc/projects/${MWS_PROJECT}/externalAddresses/anu-live-1-ip" -- \
  mws vpc external-address create "vpc/projects/${MWS_PROJECT}/externalAddresses/anu-live-1-ip" \
  --body '{"spec":{}}' \
  --idempotency-key "$(idem_key 'external-address-anu-live-1-ip')"

# https-from-lab / acme-http / deny-all-ingress уже существуют в реальном
# аккаунте с приоритетами 1000/1050/64000 (не 100/105/65000 из текста
# документа) — функционально идентичны требуемому: source/dest/proto/action
# совпадают, приоритеты просто сдвинуты в допустимый API-диапазон
# [1000-64535]. Ничего не создаём заново — только фиксируем это фактом ниже.
for rule in https-from-lab acme-http deny-all-ingress; do
  if exists mws vpc firewall-rule get "vpc/projects/${MWS_PROJECT}/networks/anu-live/firewallRules/${rule}"; then
    step "Firewall ${rule}: уже существует, значения сверены при подготовке скрипта — пропускаю"
  else
    echo "ВНИМАНИЕ: правило ${rule} ожидалось существующим (по факту от 2026-09-06), но get вернул 404." >&2
    echo "Проверьте вручную — этот скрипт не пытается воссоздать его автоматически, чтобы не разойтись с ожиданиями." >&2
    exit 1
  fi
done

# ssh-from-lab существует, но по факту пускает только Lab (Lab) —
# роль "ssh-from-owner" из §7.2 в нём не выполнена. Донастраиваем идемпотентно:
# читаем текущий список CIDR только чтобы РЕШИТЬ, нужно ли что-то менять;
# сама update-команда всегда передаёт оба известных адреса явно (LAB_IP +
# OWNER_SSH_IP), а не реконструирует список динамически из текста — так
# нельзя случайно потерять или исказить CIDR при разборе вывода.
# `firewall-rule update --source-spec-cidrs` заменяет список целиком, как и
# `create`, поэтому оба адреса передаются вместе, а не только новый.
step "Firewall ssh-from-lab: проверяю, включён ли IP владельца"
OWNER_CIDR="${OWNER_SSH_IP}/32"
CURRENT_SSH_CIDRS_JSON="$(mws vpc firewall-rule get "vpc/projects/${MWS_PROJECT}/networks/anu-live/firewallRules/ssh-from-lab" -f json)"
if echo "$CURRENT_SSH_CIDRS_JSON" | python3 -c "import json,sys; cidrs=json.load(sys.stdin)['spec']['source']['spec']['cidrs']; sys.exit(0 if '${OWNER_CIDR}' in cidrs else 1)"; then
  step "Firewall ssh-from-lab: ${OWNER_CIDR} уже разрешён — пропускаю"
else
  step "Firewall ssh-from-lab: добавляю ${OWNER_CIDR} (сохраняя существующий ${LAB_IP}/32)"
  run mws vpc firewall-rule update "vpc/projects/${MWS_PROJECT}/networks/anu-live/firewallRules/ssh-from-lab" \
    --source-spec-cidrs "${LAB_IP}/32" \
    --source-spec-cidrs "${OWNER_CIDR}" \
    --idempotency-key "$(idem_key 'firewall-ssh-from-lab-add-owner')"
fi

echo "tcp/7400 intra-subnet — только со вторым узлом (L8/P9, не сейчас) — правило намеренно не создаётся."

# ===========================================================================
# 7. Диски (§7.2) — VM anu-live-1 уже существует, не создаётся и не меняется здесь
# ===========================================================================
section "Compute: диски"

ensure "Диск anu-live-1-boot" \
  mws compute disk get "compute/projects/${MWS_PROJECT}/disks/anu-live-1-boot" -- \
  mws compute disk create "compute/projects/${MWS_PROJECT}/disks/anu-live-1-boot" \
  --zone "${MWS_ZONE}" --size 50GB --os-type LINUX \
  --disk-type compute/diskTypes/nbs-pl2 \
  --source-image compute/projects/mws-ubuntu/images/mws-ubuntu-2404-lts-v20260324 \
  --idempotency-key "$(idem_key 'disk-anu-live-1-boot')"

ensure "Диск anu-live-evidence-01 (300GB)" \
  mws compute disk get "compute/projects/${MWS_PROJECT}/disks/anu-live-evidence-01" -- \
  mws compute disk create "compute/projects/${MWS_PROJECT}/disks/anu-live-evidence-01" \
  --zone "${MWS_ZONE}" --size 300GB --disk-type compute/diskTypes/nbs-pl2 --iops 3000 \
  --idempotency-key "$(idem_key 'disk-anu-live-evidence-01')"

if exists mws compute vm get "compute/projects/${MWS_PROJECT}/virtualMachines/anu-live-1"; then
  step "VM anu-live-1: уже существует и работает (base-4-8, интерим до квоты base-8-32) — не трогаю"
else
  echo "ВНИМАНИЕ: VM anu-live-1 ожидалась существующей (по факту от 2026-09-06), но get вернул 404." >&2
  echo "Это меняет весь план — она либо была удалена, либо это другой проект/профиль. Остановка для ручной проверки." >&2
  exit 1
fi

# ===========================================================================
# 8. РУЧНОЙ ШАГ (НЕ выполняется этим скриптом): подключить evidence-диск и
#    внешний адрес к уже работающей VM anu-live-1
# ===========================================================================
section "РУЧНОЙ ШАГ: подключение evidence-диска и внешнего адреса к anu-live-1"
cat <<'EOF'
`mws compute vm update` принимает --storage-disks и --network-interfaces как
повторяемые флаги — по тексту --help это похоже на ПОЛНУЮ ЗАМЕНУ списка (тот
же паттерн, что и в `create`), а не слияние с уже существующими значениями.
Собрать команду неправильно на РАБОТАЮЩЕЙ VM значит рискнуть отключить её
текущий boot-диск или сетевой интерфейс. Поэтому:

1. Прямо перед выполнением получите СВЕЖЕЕ состояние VM (не полагайтесь на
   значения из более раннего запуска этого скрипта или из документации):

     mws compute vm get compute/projects/${MWS_PROJECT}/virtualMachines/anu-live-1 -f json

2. Соберите --storage-disks дважды: с текущей boot-записью БЕЗ ИЗМЕНЕНИЙ
   (скопировать из шага 1, поле status.storage.disks) и новой evidence-
   записью:

     --storage-disks 'boot: true, deviceName: boot, disk: {ref: "compute/projects/${MWS_PROJECT}/disks/anu-live-1-boot"}' \
     --storage-disks 'boot: false, deviceName: evidence, disk: {ref: "compute/projects/${MWS_PROJECT}/disks/anu-live-evidence-01"}'

3. Соберите --network-interfaces с текущим адресом БЕЗ ИЗМЕНЕНИЙ (поле
   status.network.networkInterfaces[0].addresses[0].ref из шага 1) плюс
   oneToOneNat на новый внешний адрес:

     --network-interfaces 'primary: true, name: eth0, addresses: [{address: {ref: "vpc/projects/${MWS_PROJECT}/networks/anu-live/addresses/anu-live-1-internal"}, oneToOneNat: {external: {address: {ref: "vpc/projects/${MWS_PROJECT}/externalAddresses/anu-live-1-ip"}}}}]'

4. Рекомендация: сделать это при кратком плановом простое, а не «на живую» —
   гарантии hot-attach в документации CLI не подтверждены:

     mws compute vm update compute/projects/${MWS_PROJECT}/virtualMachines/anu-live-1 --hardware-power OFF --wait-timeout 3m
     mws compute vm update compute/projects/${MWS_PROJECT}/virtualMachines/anu-live-1 \
       --storage-disks '...' --storage-disks '...' \
       --network-interfaces '...' \
       --idempotency-key "<новый UUID>"
     mws compute vm update compute/projects/${MWS_PROJECT}/virtualMachines/anu-live-1 --hardware-power ON

5. После включения — примонтировать evidence-диск внутри VM (см.
   cloud-init.yaml, тот же блок форматирования/монтирования в
   /var/lib/anu-live, который применяется при первом создании — здесь его
   нужно выполнить вручную по SSH, cloud-init второй раз не запустится).

Зафиксируйте фактический путь устройства (lsblk) и итоговый результат в
docs/GENESIS_LIVE.md §8, как и для остальных "Operational facts to record at
first launch".
EOF

# ===========================================================================
# 9. Registry (§7.2) — уже существует, проверка вместо создания
# ===========================================================================
section "Registry: проверка anu / agent-native-universe-lab"

if exists mws registry registry get "registry/projects/${MWS_PROJECT}/registries/anu"; then
  step "Реестр anu: уже существует — пропускаю"
else
  step "Реестр anu: не найден — создаю"
  run mws registry registry create "registry/projects/${MWS_PROJECT}/registries/anu" \
    --ip-filter-mode WHITELIST --ip-filter-operations PUSH \
    --ip-filter-source-ip-cidr-ranges "${LAB_IP}/32"
fi

if exists mws registry repository get "registry/projects/${MWS_PROJECT}/registries/anu/repositories/agent-native-universe-lab"; then
  step "Репозиторий agent-native-universe-lab: уже существует — пропускаю"
else
  step "Репозиторий agent-native-universe-lab: не найден — создаю"
  run mws registry repository create "registry/projects/${MWS_PROJECT}/registries/anu/repositories/agent-native-universe-lab" \
    --registry anu
fi

run mws registry configure-docker

echo "Сборка и push образа — scripts/live/build-push.sh (запускается отдельно, не отсюда)."

# ===========================================================================
# 10. Напоминание: DNS (ручной шаг, выполняется отдельно от этого скрипта)
# ===========================================================================
section "DNS (напоминание — выполняется отдельно, не этим скриптом)"
cat <<'EOF'
Когда внешний адрес anu-live-1-ip получит значение (см. раздел 8 выше),
заведите A-запись витрины Observer в панели управления зоной:

  <имя витрины> A <external-ip>

Имя берётся из ANU_LIVE_DOMAIN (deploy/mws/target.env), зона обслуживается
собственными NS владельца. Публикация DNS-записи — необратимое публичное
действие (домен станет виден всем), поэтому эта команда намеренно НЕ
выполняется автоматически этим скриптом.
EOF

# ===========================================================================
# 11. Напоминание: резервное копирование (настраивается отдельно, на VM)
# ===========================================================================
section "Backup (напоминание — настраивается через deploy/mws/backup.timer на VM)"
cat <<'EOF'
Ежедневный disk-backup (cron 0 3 * * *, хранить 14 последних копий) настроен
не здесь, а systemd-таймером на самой VM — см. deploy/mws/backup.timer,
deploy/mws/backup.service и deploy/mws/backup.sh. Этот скрипт таймер не
устанавливает и не включает (systemctl enable --now backup.timer — отдельный
шаг на VM, cloud-init.yaml его тоже не делает автоматически).
EOF

# ===========================================================================
# 12. Напоминание: аварийная остановка мышления
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
echo "Провижининг/донастройка из §7.2 завершены там, где это безопасно автоматизировать."
echo "Оставшееся: role bindings, значения секретов, подключение диска+адреса к VM (раздел 8), DNS, S3, образ — см. RUNBOOK.md."
