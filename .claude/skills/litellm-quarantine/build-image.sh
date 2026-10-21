#!/usr/bin/env bash
set -euo pipefail
alias_name="${AREA51_LITELLM_IMAGE:?Set a disposable image alias}"
builder="area51-litellm-builder-${GITHUB_RUN_ID:-$$}"
[[ "$alias_name" =~ ^[a-zA-Z0-9-]+$ ]]
cleanup() { incus delete "$builder" --force >/dev/null 2>&1 || true; }
trap cleanup EXIT
incus launch images:debian/12/cloud "$builder" --vm -c limits.cpu=2 -c limits.memory=3GiB
ready=false
for _ in $(seq 1 90); do
  if incus exec "$builder" -- true >/dev/null 2>&1; then ready=true; break; fi
  sleep 2
done
test "$ready" = true
incus exec "$builder" -- bash -lc '
  set -euo pipefail
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends python3 python3-venv ca-certificates
  useradd --uid 1000 --create-home node
  mkdir -p /workspace
  chown 1000:1000 /workspace
  python3 -m venv /opt/litellm
  /opt/litellm/bin/pip install --disable-pip-version-check --only-binary=:all: litellm==1.106.2
  /opt/litellm/bin/pip check
  /opt/litellm/bin/pip list --format=json > /opt/litellm/python-packages.json
  /opt/litellm/bin/pip freeze > /opt/litellm/requirements.lock
  find / -xdev -perm -4000 -type f -exec chmod u-s {} + || true
  rm -rf /var/lib/apt/lists/* /root/.cache/pip
'
incus stop "$builder"
incus publish "$builder" --alias "$alias_name"
