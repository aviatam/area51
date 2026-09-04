#!/usr/bin/env bash
# Build the local Incus image required by AREA51_RUNTIME_BACKEND=incus.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ALIAS="${AREA51_INCUS_IMAGE_ALIAS:-area51-agent-v2}"
BASE_IMAGE="${AREA51_INCUS_BASE_IMAGE:-images:debian/12/cloud}"
BUILDER="area51-image-builder-$$"
BUN_VERSION="${BUN_VERSION:-1.3.12}"
PNPM_VERSION="${PNPM_VERSION:-10.33.0}"

cleanup() {
  incus delete "$BUILDER" --force >/dev/null 2>&1 || true
}
trap cleanup EXIT

if incus image info "$ALIAS" >/dev/null 2>&1; then
  echo "Incus image alias '$ALIAS' already exists; delete or rename it explicitly before rebuilding." >&2
  exit 2
fi

incus launch "$BASE_IMAGE" "$BUILDER"
incus exec "$BUILDER" -- bash -lc "
  set -euo pipefail
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates chromium curl git tini unzip
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y --no-install-recommends nodejs
  curl -fsSL https://bun.sh/install | bash -s bun-v${BUN_VERSION}
  install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun
  corepack enable
  corepack prepare pnpm@${PNPM_VERSION} --activate
  mkdir -p /app /home/node /workspace
  chown -R 1000:1000 /home/node /workspace
"

incus file push "$CONTAINER_DIR/agent-runner/package.json" "$BUILDER/app/package.json"
incus file push "$CONTAINER_DIR/agent-runner/bun.lock" "$BUILDER/app/bun.lock"
incus file push "$CONTAINER_DIR/cli-tools.json" "$BUILDER/tmp/cli-tools.json"
incus file push "$CONTAINER_DIR/install-cli-tools.sh" "$BUILDER/tmp/install-cli-tools.sh"

incus exec "$BUILDER" -- bash -lc "
  set -euo pipefail
  cd /app
  bun install --frozen-lockfile
  export PNPM_HOME=/usr/local/bin
  chmod +x /tmp/install-cli-tools.sh
  /tmp/install-cli-tools.sh /tmp/cli-tools.json
  find / -xdev -perm -4000 -type f -exec chmod u-s {} + || true
  rm -rf /root/.bun /var/lib/apt/lists/*
"

incus stop "$BUILDER"
incus publish "$BUILDER" --alias "$ALIAS" \
  description="Area51 agent runtime: Bun, agent dependencies, and pinned CLI tools"

echo "Built local:$ALIAS"
echo "Set AREA51_INCUS_IMAGE=local:$ALIAS and AREA51_RUNTIME_BACKEND=incus"
