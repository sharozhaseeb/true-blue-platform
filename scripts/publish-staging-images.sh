#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <release-tag> [dockerhub-namespace]" >&2
  exit 1
fi

TAG="$1"
NAMESPACE="${2:-${DOCKERHUB_NAMESPACE:-sharozhaseeb}}"

APP_IMAGE="docker.io/${NAMESPACE}/true-blue-platform-app:${TAG}"
MIGRATE_IMAGE="docker.io/${NAMESPACE}/true-blue-platform-migrate:${TAG}"
WORKER_IMAGE="docker.io/${NAMESPACE}/true-blue-platform-worker:${TAG}"

echo "Publishing images:"
echo "  APP_IMAGE=${APP_IMAGE}"
echo "  MIGRATE_IMAGE=${MIGRATE_IMAGE}"
echo "  WORKER_IMAGE=${WORKER_IMAGE}"

docker login docker.io

docker buildx build \
  --platform linux/amd64 \
  --target runner \
  -t "${APP_IMAGE}" \
  --push \
  .

docker buildx build \
  --platform linux/amd64 \
  --target migrate \
  -t "${MIGRATE_IMAGE}" \
  --push \
  .

docker buildx build \
  --platform linux/amd64 \
  --target worker \
  -t "${WORKER_IMAGE}" \
  --push \
  .

echo
echo "Published successfully."
echo "APP_IMAGE=${APP_IMAGE}"
echo "MIGRATE_IMAGE=${MIGRATE_IMAGE}"
echo "WORKER_IMAGE=${WORKER_IMAGE}"
