#!/usr/bin/env bash
# Build the VM-native image required before Area51 can enable Incus VM mode.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ALIAS="${AREA51_INCUS_VM_IMAGE_ALIAS:-area51-agent-v2-vm}"
BASE_IMAGE="${AREA51_INCUS_VM_BASE_IMAGE:-images:debian/12/cloud}"
BUILDER="area51-vm-image-builder-$$"
BUN_VERSION="${BUN_VERSION:-1.3.12}"
PNPM_VERSION="${PNPM_VERSION:-10.33.0}"

cleanup() {
  incus delete "$BUILDER" --force >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ ! -e /dev/kvm ]]; then
  echo 'A KVM-capable Linux host is required to build the Area51 VM image.' >&2
  exit 1
fi
if incus image info "$ALIAS" >/dev/null 2>&1; then
  echo "Incus image alias '$ALIAS' already exists; delete or rename it explicitly before rebuilding." >&2
  exit 2
fi

incus launch "$BASE_IMAGE" "$BUILDER" --vm -c limits.cpu=2 -c limits.memory=3GiB

ready=false
for _ in $(seq 1 90); do
  if incus exec "$BUILDER" -- true >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  echo 'Incus guest agent did not become ready within 180 seconds.' >&2
  exit 1
fi

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
  mkdir -p /app/src /app/skills /home/node /workspace /etc/area51
  printf '%s\n' vm > /etc/area51/image-kind
  chown -R 1000:1000 /home/node /workspace
"

incus file push "$CONTAINER_DIR/agent-runner/package.json" "$BUILDER/app/package.json"
incus file push "$CONTAINER_DIR/agent-runner/bun.lock" "$BUILDER/app/bun.lock"
incus file push -r "$CONTAINER_DIR/agent-runner/src" "$BUILDER/app/"
incus file push -r "$CONTAINER_DIR/skills" "$BUILDER/app/"
incus file push "$CONTAINER_DIR/CLAUDE.md" "$BUILDER/app/CLAUDE.md"
incus file push "$CONTAINER_DIR/cli-tools.json" "$BUILDER/tmp/cli-tools.json"
incus file push "$CONTAINER_DIR/install-cli-tools.sh" "$BUILDER/tmp/install-cli-tools.sh"

incus exec "$BUILDER" -- bash -lc "
  set -euo pipefail
  cd /app
  bun install --frozen-lockfile
  export PNPM_HOME=/usr/local/bin
  chmod +x /tmp/install-cli-tools.sh
  /tmp/install-cli-tools.sh /tmp/cli-tools.json
  chown -R 1000:1000 /app
  find / -xdev -perm -4000 -type f -exec chmod u-s {} + || true
  rm -rf /root/.bun /var/lib/apt/lists/* /tmp/cli-tools.json /tmp/install-cli-tools.sh
  test -x /usr/local/bin/bun
  test -d /app/node_modules
  test -f /app/src/index.ts
  test \"\$(cat /etc/area51/image-kind)\" = vm
"

incus stop "$BUILDER"
incus publish "$BUILDER" --alias "$ALIAS" \
  description="Area51 VM agent runtime: baked runner, Bun, dependencies, and pinned CLI tools"

echo "Built local:$ALIAS"
echo "Do not enable VM execution until the KVM smoke workflow and containment E2E pass."
