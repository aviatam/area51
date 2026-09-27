#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
output_dir="${1:-.area51/agent-security-lab}"
if test -e "$output_dir"; then
  echo "Output already exists: $output_dir" >&2
  exit 1
fi
node --import tsx .claude/skills/governed-escalation-demo/scripts/run.ts --output-dir "$output_dir"
node lab/agent-security/verify.mjs "$output_dir"
