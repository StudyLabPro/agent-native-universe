#!/usr/bin/env bash
#
# scripts/live/build-push.sh — собирает и пушит образ движка в реестр MWS
# для постоянного живого инстанса (фаза L5a, docs/GENESIS_LIVE.md §7.2,
# блок "Реестр образов"). Реестр (registry/repository create,
# configure-docker) создаётся в deploy/mws/provision.sh — этот скрипт
# только собирает и пушит, запускается отдельно и может запускаться
# многократно (по одному разу на релиз в Live).
#
# Dockerfile.lab уже существует в этом репозитории (корень репо) — тот же
# файл, что используют compose.lab.yml и Lab-стек на этом хосте. Отдельный
# Dockerfile для Live не заводится: L5a переиспользует L3c/готовый образ,
# отличие Live — только тег (live-<sha>) и переменные окружения контейнера
# (compose.live.yml, ещё не существует — фаза L5b).
set -euo pipefail

# По умолчанию — хост реестра из `mws registry configure-docker --help`
# ("Если флаг не задан, используется реестр registry.mwsapis.ru").
# НЕПРОВЕРЕННЫЙ ФАКТ: включает ли полный путь образа имя проекта
# (project-vxgxs2) между хостом реестра и "anu", или "anu" сразу после
# хоста, как в буквальной команде §7.2 — сверить при первом реальном push и
# при необходимости поправить MWS_REGISTRY_HOST/переменную ниже.
readonly MWS_REGISTRY_HOST="${MWS_REGISTRY_HOST:-registry.mwsapis.ru}"
readonly IMAGE_PATH="${MWS_REGISTRY_HOST}/anu/agent-native-universe-lab"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly REPO_ROOT
cd "$REPO_ROOT"

[[ -f "Dockerfile.lab" ]] || {
  echo "Ошибка: Dockerfile.lab не найден в ${REPO_ROOT}. Ожидался существующий файл (уже используется compose.lab.yml)." >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || { echo "Ошибка: docker не найден в PATH." >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "Ошибка: git не найден в PATH." >&2; exit 1; }

SHORT_SHA="$(git rev-parse --short HEAD)"
readonly SHORT_SHA
FULL_SHA="$(git rev-parse HEAD)"
readonly FULL_SHA
readonly ANU_VERSION="live-${SHORT_SHA}"
readonly IMAGE_TAG="${IMAGE_PATH}:${ANU_VERSION}"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Предупреждение: рабочее дерево не чистое — образ ${IMAGE_TAG} будет собран из HEAD (${FULL_SHA})," >&2
  echo "а не из незакоммиченных изменений. Закоммитьте перед сборкой, если хотите включить их в образ." >&2
fi

echo "build-push.sh: сборка ${IMAGE_TAG} (VCS_REF=${FULL_SHA})"
docker build \
  -f Dockerfile.lab \
  --build-arg "ANU_VERSION=${ANU_VERSION}" \
  --build-arg "VCS_REF=${FULL_SHA}" \
  -t "$IMAGE_TAG" \
  .

echo "build-push.sh: push ${IMAGE_TAG}"
echo "(предполагается, что 'mws registry configure-docker' уже выполнен владельцем — иначе push откажет в доступе)"
docker push "$IMAGE_TAG"

echo
echo "Готово: ${IMAGE_TAG}"
echo "Впишите этот тег в первый реальный деплой compose.live.yml (фаза L5b, ещё не существует)."
