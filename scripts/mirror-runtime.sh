#!/usr/bin/env bash
# Optional first-release preparation on the deployment host. Never publishes an application tag.
set -euo pipefail
umask 077
registry=ccr.ccs.tencentyun.com
source_image=node:22.22.0-alpine@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34
target_image="${registry}/lazycampus/lazycampus-status:base-node22-20260911"
secret_dir="${SECRET_DIR:-/etc/platform-secrets}"
for name in tcr-username tcr-password; do test -s "${secret_dir}/${name}"; done
temporary_directory="$(mktemp -d /var/tmp/status-runtime-mirror.XXXXXX)"
case "$temporary_directory" in /var/tmp/status-runtime-mirror.*) ;; *) exit 1 ;; esac
cleanup() {
  case "$temporary_directory" in /var/tmp/status-runtime-mirror.*) rm -rf -- "$temporary_directory" ;; esac
}
trap cleanup EXIT
export DOCKER_CONFIG="${temporary_directory}/docker-config"
install -d -m 0700 "$DOCKER_CONFIG"
docker login "$registry" --username "$(cat "${secret_dir}/tcr-username")" --password-stdin <"${secret_dir}/tcr-password" >/dev/null 2>&1
docker pull --platform linux/amd64 "$source_image"
docker tag "$source_image" "$target_image"
timeout 300s docker push "$target_image"
docker image inspect "$target_image" --format '{{index .RepoDigests 0}}'
