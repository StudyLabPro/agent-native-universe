#!/usr/bin/env bash
#
# deploy/mws/s3-bucket.sh — создаёт S3-бакет anu-live-anchors для якорения
# (фаза L5a, docs/GENESIS_LIVE.md §7.2). У `mws` нет группы команд для
# объектного хранилища — S3-совместимый API вызывается напрямую через
# aws-cli под HMAC-ключом сервисного аккаунта anu-anchor (создан в
# provision.sh: iam hmac-key create .../serviceAccounts/anu-anchor/hmacKeys/anchors).
#
# TODO (владелец): подтвердить домен эндпоинта S3 по документации MWS и
# вписать сюда/в docs/GENESIS_LIVE.md. Этот скрипт намеренно не содержит
# предположительного адреса — читает его из обязательной переменной
# MWS_S3_ENDPOINT и падает с понятной ошибкой, если она не задана.
set -euo pipefail

readonly BUCKET="anu-live-anchors"

: "${MWS_S3_ENDPOINT:?$(cat <<'EOF'
Ошибка: переменная окружения MWS_S3_ENDPOINT не задана.

TODO: подтвердить домен S3-эндпоинта MWS по официальной документации
провайдера и вписать сюда/в docs/GENESIS_LIVE.md (см. §8 "Operational facts
to record at first launch"). До этого момента значение намеренно не
предполагается этим скриптом. Пример запуска после подтверждения:

  MWS_S3_ENDPOINT=https://<подтверждённый-домен> \
  AWS_ACCESS_KEY_ID=<accessKeyId из hmac-key anchors> \
  AWS_SECRET_ACCESS_KEY=<secretAccessKey из hmac-key anchors> \
  ./deploy/mws/s3-bucket.sh
EOF
)}"
: "${AWS_ACCESS_KEY_ID:?Ошибка: AWS_ACCESS_KEY_ID не задан (accessKeyId HMAC-ключа anchors сервисного аккаунта anu-anchor).}"
: "${AWS_SECRET_ACCESS_KEY:?Ошибка: AWS_SECRET_ACCESS_KEY не задан (secretAccessKey того же HMAC-ключа).}"

command -v aws >/dev/null 2>&1 || {
  echo "Ошибка: aws-cli не найден в PATH. Установите aws-cli — это самый простой корректный способ" \
       "говорить с S3-совместимым API без написания HTTP-подписи вручную." >&2
  exit 1
}

# aws-cli требует какой-то регион даже для S3-совместимых эндпоинтов, где
# регион фактически не используется провайдером; значение ниже — заглушка,
# не влияющая на маршрутизацию запроса (идёт по --endpoint-url).
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

echo "s3-bucket.sh: создаю бакет ${BUCKET} на ${MWS_S3_ENDPOINT}"
if aws --endpoint-url "$MWS_S3_ENDPOINT" s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "s3-bucket.sh: бакет ${BUCKET} уже существует — CreateBucket пропущен (идемпотентно по факту)."
else
  aws --endpoint-url "$MWS_S3_ENDPOINT" s3api create-bucket --bucket "$BUCKET"
fi

echo "s3-bucket.sh: включаю versioning на ${BUCKET}"
aws --endpoint-url "$MWS_S3_ENDPOINT" s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

echo "s3-bucket.sh: контрольное чтение (readback) versioning-статуса"
STATUS_JSON="$(aws --endpoint-url "$MWS_S3_ENDPOINT" s3api get-bucket-versioning --bucket "$BUCKET")"
echo "$STATUS_JSON"

STATUS_VALUE="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('Status', 'MISSING'))" "${STATUS_JSON:-\{\}}" 2>/dev/null || echo "MISSING")"
if [[ "$STATUS_VALUE" != "Enabled" ]]; then
  echo "s3-bucket.sh: ВНИМАНИЕ — readback не подтвердил Status=Enabled (получено: ${STATUS_VALUE})." >&2
  echo "Зафиксируйте фактический результат в docs/GENESIS_LIVE.md (§7.2 требует явной записи да/нет)." >&2
  exit 1
fi

echo "s3-bucket.sh: versioning подтверждён (Status=Enabled)."
echo
echo "object-lock: этот скрипт его не включает (в §7.2 явно указано зафиксировать"
echo "как есть/нет, а не предполагать) — проверьте отдельно:"
echo "  aws --endpoint-url \"$MWS_S3_ENDPOINT\" s3api get-object-lock-configuration --bucket ${BUCKET}"
echo "и впишите результат в docs/GENESIS_LIVE.md."
