#!/usr/bin/env bash
#
# scripts/live/build-push.sh — собирает и пушит образ движка в реестр MWS
# для постоянного живого инстанса (фазы L5a/L5b, docs/GENESIS_LIVE.md §7.2).
# Реестр (registry/repository create, configure-docker) создаётся в
# deploy/mws/provision.sh — этот скрипт только собирает и пушит.
#
# Dockerfile.lab уже существует в корне репозитория — тот же файл, что
# используют compose.lab.yml и compose.live.yml. Отдельного Dockerfile для
# Live нет: отличие Live — только тег (live-<sha>) и окружение контейнера.
#
# ПУБЛИКАЦИОННАЯ ГРАНИЦА: имя проекта в реестре — внешний инфраструктурный
# контекст, и в этом (публичном) репозитории его нет. Оно приходит из
# переменной MWS_PROJECT, которую оператор кладёт в deploy/mws/target.env
# (в git не входит, см. deploy/mws/target.env.example).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly REPO_ROOT
cd "$REPO_ROOT"

# Локальный файл цели (адреса, имя проекта, пользователь SSH) — не в git.
# Источается ДО объявления readonly-переменных: он может задавать и хост
# реестра, а присваивание уже объявленной readonly оборвало бы скрипт.
TARGET_ENV="${ANU_LIVE_TARGET_ENV:-${REPO_ROOT}/deploy/mws/target.env}"
if [[ -f "$TARGET_ENV" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$TARGET_ENV"
  set +a
fi

: "${MWS_PROJECT:?MWS_PROJECT не задан: заполните deploy/mws/target.env по образцу target.env.example}"

readonly MWS_REGISTRY_HOST="${MWS_REGISTRY_HOST:-registry.mwsapis.ru}"

# ПРОВЕРЕНО читающим запросом к реестру (2026-09-08): путь без имени проекта
# реестр отвергает —
#   GET /v2/anu/agent-native-universe-lab/tags/list
#   -> 400 NAME_INVALID "repository name format should be <project>/<registry>/<repository>",
# тот же запрос с префиксом проекта -> 401 UNAUTHORIZED, то есть имя принято.
# Поэтому путь всегда трёхсегментный: <проект>/<реестр>/<репозиторий>.
readonly IMAGE_PATH="${MWS_REGISTRY_HOST}/${MWS_PROJECT}/anu/agent-native-universe-lab"

[[ -f "Dockerfile.lab" ]] || {
  echo "Ошибка: Dockerfile.lab не найден в ${REPO_ROOT}." >&2
  exit 1
}
command -v docker >/dev/null 2>&1 || { echo "Ошибка: docker не найден в PATH." >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "Ошибка: git не найден в PATH." >&2; exit 1; }

# --- Предохранитель: ресурсы машины сборки --------------------------------
# Симметрично проверке свободного места в bootstrap-anu-live-1.sh. Сборка
# идёт на общем многоагентном хосте, где место и память кончаются молча.
readonly MIN_BUILD_FREE_GIB="${ANU_BUILD_MIN_FREE_GIB:-15}"
build_free_gib=$(df -BG --output=avail . | tail -1 | tr -dc '0-9')
build_avail_mib=$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo)
echo "build-push.sh: свободно на диске ${build_free_gib} GB, доступно памяти ${build_avail_mib} MiB"
if (( build_free_gib < MIN_BUILD_FREE_GIB )); then
  echo "Ошибка: меньше ${MIN_BUILD_FREE_GIB} GB свободного места — сборка забьёт диск общего хоста." >&2
  echo "Освобождение build cache (docker builder prune) — решение главного агента, не этого скрипта." >&2
  exit 1
fi
if (( build_avail_mib < 2048 )); then
  echo "Ошибка: меньше 2 GiB доступной памяти — вероятно, рядом идёт другая сборка. Дождитесь её." >&2
  exit 1
fi

# --- Предохранитель: тег обязан называть ровно тот код, что в образе ------
# `docker build … .` собирает из РАБОЧЕГО ДЕРЕВА, а не из HEAD. Тег
# live-<sha> при грязном дереве назвал бы чужой коммит, а для трека, где
# пиннутый тег — единственный якорь воспроизводимости физики, это делает
# улики непроверяемыми. Поэтому отказ, а не предупреждение.
# `git status --porcelain` (в отличие от `git diff`) видит и untracked.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Ошибка: рабочее дерево не чистое. docker build собирает из рабочего дерева," >&2
  echo "поэтому тег live-<sha> назвал бы коммит, которого в образе нет." >&2
  echo "Закоммитьте (или уберите) изменения, либо задайте ANU_ALLOW_DIRTY_BUILD=1 —" >&2
  echo "тогда тег получит суффикс -dirty и такой образ НЕЛЬЗЯ ставить в Live." >&2
  git status --porcelain >&2
  [[ "${ANU_ALLOW_DIRTY_BUILD:-0}" == "1" ]] || exit 1
  DIRTY_SUFFIX="-dirty"
else
  DIRTY_SUFFIX=""
fi
readonly DIRTY_SUFFIX

SHORT_SHA="$(git rev-parse --short HEAD)"
readonly SHORT_SHA
FULL_SHA="$(git rev-parse HEAD)"
readonly FULL_SHA
readonly ANU_VERSION="live-${SHORT_SHA}${DIRTY_SUFFIX}"
readonly IMAGE_TAG="${IMAGE_PATH}:${ANU_VERSION}"

echo "build-push.sh: сборка ${IMAGE_TAG} (VCS_REF=${FULL_SHA})"
docker build \
  -f Dockerfile.lab \
  --build-arg "ANU_VERSION=${ANU_VERSION}" \
  --build-arg "VCS_REF=${FULL_SHA}" \
  -t "$IMAGE_TAG" \
  .

echo "build-push.sh: push ${IMAGE_TAG}"
docker push "$IMAGE_TAG"

# --- Обязательный выход из реестра ----------------------------------------
# Учётные данные docker login лежат в ~/.docker/config.json открытым
# base64. Этот хост — единственный, которому реестр разрешает PUSH образа
# живой вселенной: пока логин не снят, любой root-процесс на нём может
# подменить код и физику вселенной. Поэтому logout — часть скрипта.
if [[ "${ANU_KEEP_REGISTRY_LOGIN:-0}" == "1" ]]; then
  echo "build-push.sh: ВНИМАНИЕ, logout пропущен по ANU_KEEP_REGISTRY_LOGIN=1 —"
  echo "  учётные данные ${MWS_REGISTRY_HOST} остаются в ~/.docker/config.json в открытом виде."
else
  docker logout "$MWS_REGISTRY_HOST"
  echo "build-push.sh: выполнен docker logout ${MWS_REGISTRY_HOST}"
fi

echo
echo "Готово: ${IMAGE_TAG}"
echo "Впишите этот тег в ANU_LIVE_IMAGE в /opt/anu-live/.env на VM (DEPLOY_LIVE.md, Ш6a)."
