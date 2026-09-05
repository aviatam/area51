#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${AREA51_INSTALL_DIR:-$HOME/area51}"
REPOSITORY="${AREA51_REPOSITORY:-https://github.com/aviatam/area51.git}"
REF="${AREA51_REF:-main}"
PLAN=false
YES=false

usage() {
  cat <<'EOF'
Usage: install-wsl.sh [--plan] [--yes] [--install-dir PATH] [--ref REF]

Installs Area51 and its Docker runtime inside WSL2. For a Windows-first setup,
run install-windows.ps1 from an Administrator PowerShell session.
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

FAILED=false
[ "$(uname -s)" = Linux ] && pass 'Linux guest' || fail 'WSL2 Linux is required'
grep -qi 'microsoft\|wsl' /proc/version 2>/dev/null && pass 'WSL detected' || fail 'run this installer inside WSL2'
[ "$(id -u)" -ne 0 ] && pass 'regular user' || fail 'configure a regular default WSL user, not root'
command -v sudo >/dev/null 2>&1 && pass 'sudo available' || fail 'sudo is required'
command -v apt-get >/dev/null 2>&1 && pass 'apt available' || fail 'an Ubuntu or Debian WSL distribution is required'
command -v curl >/dev/null 2>&1 && pass 'curl available' || fail 'curl is required'

MEM_MB="$(awk '/^MemTotal:/ {printf "%d", $2 / 1024}' /proc/meminfo 2>/dev/null || echo 0)"
[ "$MEM_MB" -ge 3700 ] && pass "memory ${MEM_MB}MB" || fail "at least 4GB RAM must be assigned to WSL2 (${MEM_MB}MB detected)"

if [ "$FAILED" = true ]; then
  echo 'WSL2 prerequisite check failed; no installation changes were made.' >&2
  exit 2
fi
if [ "$PLAN" = true ]; then
  echo "PLAN install Area51 into $INSTALL_DIR from $REF"
  echo 'PLAN runtime Docker in WSL2; isolation local'
  exit 0
fi

if [ "$(ps -p 1 -o comm= 2>/dev/null | tr -d ' ')" != systemd ] && ! docker info >/dev/null 2>&1; then
  WSL_CONF_TMP="$(mktemp)"
  trap 'rm -f "$WSL_CONF_TMP"' EXIT
  awk '
    BEGIN { in_boot=0; saw_boot=0; set_systemd=0 }
    /^\[/ {
      if (in_boot && !set_systemd) { print "systemd=true"; set_systemd=1 }
      in_boot=($0 == "[boot]")
      if (in_boot) saw_boot=1
    }
    in_boot && /^[[:space:]]*systemd[[:space:]]*=/ {
      print "systemd=true"; set_systemd=1; next
    }
    { print }
    END {
      if (in_boot && !set_systemd) print "systemd=true"
      if (!saw_boot) print "\n[boot]\nsystemd=true"
    }
  ' /etc/wsl.conf 2>/dev/null > "$WSL_CONF_TMP" || printf '[boot]\nsystemd=true\n' > "$WSL_CONF_TMP"
  sudo install -m 0644 "$WSL_CONF_TMP" /etc/wsl.conf
  echo 'Systemd enabled in /etc/wsl.conf; the Windows installer will restart this distribution.'
  exit 3
fi

if [ "$YES" != true ]; then
  printf 'Install Docker and Area51 into %s inside WSL2? [y/N] ' "$INSTALL_DIR"
  read -r answer </dev/tty
  case "$answer" in [Yy]*) ;; *) echo 'Cancelled.'; exit 1 ;; esac
fi

sudo -v
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update
sudo apt-get install -y --no-install-recommends ca-certificates curl git build-essential

if [ -e "$INSTALL_DIR" ]; then
  [ -d "$INSTALL_DIR/.git" ] || { echo "Install path exists and is not a Git checkout: $INSTALL_DIR" >&2; exit 1; }
  [ -z "$(git -C "$INSTALL_DIR" status --porcelain)" ] || { echo "Existing checkout has local changes: $INSTALL_DIR" >&2; exit 1; }
else
  git clone --branch "$REF" --single-branch "$REPOSITORY" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
bash area51.sh

echo "Area51 WSL2 deployment complete: $INSTALL_DIR"
echo 'Runtime: Docker in WSL2; service: systemd or the existing WSL fallback.'
echo 'For production Incus/KVM isolation, deploy the Linux installer on a supported Linux host.'
