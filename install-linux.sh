#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${AREA51_INSTALL_DIR:-$HOME/area51}"
REPOSITORY="${AREA51_REPOSITORY:-https://github.com/aviatam/area51.git}"
REF="${AREA51_REF:-main}"
PLAN=false
YES=false

usage() {
  cat <<'EOF'
Usage: install-linux.sh [--plan] [--yes] [--install-dir PATH] [--ref REF]

Installs the Linux prerequisites, Incus/KVM runtime, Area51, governed images,
and the production deployment bundle. Provider and channel authentication stay interactive.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --plan) PLAN=true ;;
    --yes) YES=true ;;
    --install-dir) shift; INSTALL_DIR="${1:?--install-dir requires a path}" ;;
    --ref) shift; REF="${1:?--ref requires a value}" ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; FAILED=true; }
note() { printf 'NOTE %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 && pass "$1 available" || fail "$1 missing"; }

FAILED=false
[ "$(uname -s)" = Linux ] && pass 'Linux host' || fail 'Linux is required'
if [ "$(id -u)" -ne 0 ]; then
  pass 'regular user'
elif [ "$PLAN" = true ] && [ "${AREA51_PLAN_ALLOW_ROOT:-}" = 1 ]; then
  note 'root accepted for plan-only contract test'
else
  fail 'run as a regular user with sudo, not root'
fi
need sudo
need apt-get

OS_RELEASE_FILE="${AREA51_OS_RELEASE_FILE:-/etc/os-release}"
if [ -r "$OS_RELEASE_FILE" ]; then
  # shellcheck disable=SC1090 -- the selected os-release file is the standard distro contract
  . "$OS_RELEASE_FILE"
else
  fail 'cannot read /etc/os-release'
fi
DISTRO="${ID:-unknown}"
CODENAME="${VERSION_CODENAME:-}"
case "$DISTRO:$CODENAME" in
  ubuntu:jammy|ubuntu:noble|debian:bookworm|debian:trixie) pass "supported distribution $DISTRO/$CODENAME" ;;
  *) fail "unsupported distribution $DISTRO/$CODENAME (supported: Ubuntu 22.04/24.04, Debian 12/13)" ;;
esac

ARCH="$(dpkg --print-architecture 2>/dev/null || true)"
case "$ARCH" in
  amd64) QEMU_PACKAGE=qemu-system-x86; pass "supported architecture $ARCH" ;;
  arm64) QEMU_PACKAGE=qemu-system-arm; pass "supported architecture $ARCH" ;;
  *) fail "unsupported architecture ${ARCH:-unknown}" ;;
esac

KVM_DEVICE="${AREA51_KVM_DEVICE:-/dev/kvm}"
[ -e "$KVM_DEVICE" ] && pass "$KVM_DEVICE exists" || fail "$KVM_DEVICE is unavailable; enable hardware or nested virtualization"
[ -r "$KVM_DEVICE" ] && pass "$KVM_DEVICE readable" || note "$KVM_DEVICE access will be granted during installation"
[ -w "$KVM_DEVICE" ] && pass "$KVM_DEVICE writable" || note "$KVM_DEVICE access will be granted during installation"

MEM_MB="$(awk '/^MemTotal:/ {printf "%d", $2 / 1024}' /proc/meminfo 2>/dev/null || echo 0)"
[ "$MEM_MB" -ge 3700 ] && pass "memory ${MEM_MB}MB" || fail "at least 4GB RAM is required (${MEM_MB}MB detected)"

if [ "$FAILED" = true ]; then
  echo 'Linux prerequisite check failed; no installation changes were made.' >&2
  exit 2
fi
if [ "$PLAN" = true ]; then
  echo "PLAN install Area51 into $INSTALL_DIR from $REF"
  exit 0
fi
if [ "$YES" != true ]; then
  printf 'Install system packages, initialize Incus, and deploy Area51 into %s? [y/N] ' "$INSTALL_DIR"
  read -r answer </dev/tty
  case "$answer" in [Yy]*) ;; *) echo 'Cancelled.'; exit 1 ;; esac
fi

sudo -v
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update
sudo apt-get install -y --no-install-recommends ca-certificates curl git gnupg acl build-essential "$QEMU_PACKAGE" qemu-utils

KEY_TMP="$(mktemp)"
trap 'rm -f "$KEY_TMP"' EXIT
curl -fsSL https://pkgs.zabbly.com/key.asc -o "$KEY_TMP"
FINGERPRINT="$(gpg --show-keys --with-colons "$KEY_TMP" | awk -F: '$1 == "fpr" { print $10; exit }')"
[ "$FINGERPRINT" = '4EFC590696CB15B87C73A3AD82CC8797C838DCFD' ] || { echo 'Zabbly signing-key fingerprint mismatch.' >&2; exit 1; }
sudo install -d -m 0755 /etc/apt/keyrings
sudo install -m 0644 "$KEY_TMP" /etc/apt/keyrings/zabbly-incus.asc
printf '%s\n' \
  'Enabled: yes' \
  'Types: deb' \
  'URIs: https://pkgs.zabbly.com/incus/lts-7.0' \
  "Suites: $CODENAME" \
  'Components: main' \
  "Architectures: $ARCH" \
  'Signed-By: /etc/apt/keyrings/zabbly-incus.asc' | sudo tee /etc/apt/sources.list.d/zabbly-incus-lts-7.0.sources >/dev/null
sudo apt-get update
sudo apt-get install -y --no-install-recommends incus
sudo systemctl enable --now incus.service

for _ in $(seq 1 30); do [ -S /var/lib/incus/unix.socket ] && break; sleep 1; done
[ -S /var/lib/incus/unix.socket ] || { echo 'Incus socket did not become ready.' >&2; exit 1; }
sudo setfacl -m "u:$(id -un):rw" /var/lib/incus/unix.socket
sudo setfacl -m "u:$(id -un):rw" "$KVM_DEVICE"
getent group incus-admin >/dev/null 2>&1 && sudo usermod -aG incus-admin "$(id -un)"
getent group kvm >/dev/null 2>&1 && sudo usermod -aG kvm "$(id -un)"
if [ -z "$(incus storage list --format csv -c n 2>/dev/null)" ]; then incus admin init --minimal; fi
incus version

if [ -e "$INSTALL_DIR" ]; then
  [ -d "$INSTALL_DIR/.git" ] || { echo "Install path exists and is not a Git checkout: $INSTALL_DIR" >&2; exit 1; }
  [ -z "$(git -C "$INSTALL_DIR" status --porcelain)" ] || { echo "Existing checkout has local changes: $INSTALL_DIR" >&2; exit 1; }
else
  git clone --branch "$REF" --single-branch "$REPOSITORY" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
[ -f .claude/skills/governed-escalation-demo/deploy.sh ] || {
  echo 'This checkout predates the governed deployment bundle. Use a fresh directory or follow the v2 migration guide.' >&2
  exit 1
}
bash .claude/skills/governed-escalation-demo/deploy.sh --mode production

echo "Area51 Linux deployment complete: $INSTALL_DIR"
echo "Evidence: $INSTALL_DIR/.area51/governed-demo/reports/deployment.json"
