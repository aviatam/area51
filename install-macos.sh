#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${AREA51_INSTALL_DIR:-$HOME/area51}"
REPOSITORY="${AREA51_REPOSITORY:-https://github.com/aviatam/area51.git}"
REF="${AREA51_REF:-main}"
PLAN=false
YES=false

usage() {
  cat <<'EOF'
Usage: install-macos.sh [--plan] [--yes] [--install-dir PATH] [--ref REF]

Installs the macOS prerequisites, Area51, its Docker runtime, and launchd
service. Provider and channel authentication stay interactive.
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

FAILED=false
[ "$(uname -s)" = Darwin ] && pass 'macOS host' || fail 'macOS is required'
[ "$(id -u)" -ne 0 ] && pass 'regular user' || fail 'run as a regular user, not root'
command -v curl >/dev/null 2>&1 && pass 'curl available' || fail 'curl is required'

ARCH="$(uname -m)"
case "$ARCH" in
  arm64|x86_64) pass "supported architecture $ARCH" ;;
  *) fail "unsupported architecture $ARCH (supported: Apple silicon or Intel)" ;;
esac

MEM_BYTES="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
MEM_MB=$((MEM_BYTES / 1024 / 1024))
[ "$MEM_MB" -ge 3700 ] && pass "memory ${MEM_MB}MB" || fail "at least 4GB RAM is required (${MEM_MB}MB detected)"

if command -v brew >/dev/null 2>&1; then
  pass 'Homebrew available'
else
  note 'Homebrew and Apple Command Line Tools will be installed'
fi
if command -v git >/dev/null 2>&1; then
  pass 'git available'
else
  note 'git will be installed with the macOS prerequisites'
fi

if [ "$FAILED" = true ]; then
  echo 'macOS prerequisite check failed; no installation changes were made.' >&2
  exit 2
fi
if [ "$PLAN" = true ]; then
  echo "PLAN install Area51 into $INSTALL_DIR from $REF"
  echo 'PLAN runtime Docker Desktop; service launchd; isolation local'
  exit 0
fi

if [ "$YES" != true ]; then
  printf 'Install macOS prerequisites, Docker Desktop, and Area51 into %s? [y/N] ' "$INSTALL_DIR"
  read -r answer </dev/tty
  case "$answer" in [Yy]*) ;; *) echo 'Cancelled.'; exit 1 ;; esac
fi

if ! command -v brew >/dev/null 2>&1; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
fi
command -v brew >/dev/null 2>&1 || { echo 'Homebrew installation did not complete.' >&2; exit 1; }

if ! command -v git >/dev/null 2>&1; then
  brew install git
fi

if [ -e "$INSTALL_DIR" ]; then
  [ -d "$INSTALL_DIR/.git" ] || { echo "Install path exists and is not a Git checkout: $INSTALL_DIR" >&2; exit 1; }
  [ -z "$(git -C "$INSTALL_DIR" status --porcelain)" ] || { echo "Existing checkout has local changes: $INSTALL_DIR" >&2; exit 1; }
else
  git clone --branch "$REF" --single-branch "$REPOSITORY" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
bash area51.sh

echo "Area51 macOS deployment complete: $INSTALL_DIR"
echo 'Runtime: Docker Desktop; service: launchd'
echo 'For production Incus/KVM isolation, deploy the Linux installer on a supported Linux host.'
