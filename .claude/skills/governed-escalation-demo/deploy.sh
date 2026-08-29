#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SKILL_DIR}/../../.." && pwd)"
cd "$PROJECT_ROOT"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage: bash .claude/skills/governed-escalation-demo/deploy.sh [options]

  --mode contract     Bootstrap dependencies and run the portable proof (default)
  --mode production   Run official setup, require Incus/KVM, build images, apply governance, and prove it
  --mode live         Run the authoritative disposable-host Incus VM E2E
  --plan              Inspect prerequisites and write a report without changing the host
  --output-dir PATH   Evidence directory (default: .area51/governed-demo)
EOF
  exit 0
fi

if ! command -v node >/dev/null 2>&1 || [ ! -x node_modules/.bin/tsx ]; then
  bash setup.sh
fi

exec node --import tsx "$SKILL_DIR/scripts/deploy.ts" "$@"
