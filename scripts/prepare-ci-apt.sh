#!/usr/bin/env bash
# Disposable GitHub Ubuntu runners only; retain normal package signature checks.
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_OS:-}" = Linux
. /etc/os-release
test "$ID" = ubuntu
for mirror_file in /etc/apt/apt-mirrors.txt /etc/apt/apt-security-mirrors.txt; do
  if test -f "$mirror_file"; then
    printf '%s\n' 'https://archive.ubuntu.com/ubuntu' | sudo tee "$mirror_file" >/dev/null
  fi
done
printf '%s\n' \
  'Acquire::http::Timeout "20";' \
  'Acquire::https::Timeout "20";' \
  'Acquire::Retries "2";' \
  'APT::Update::Error-Mode "any";' |
  sudo tee /etc/apt/apt.conf.d/99-area51-ci-network >/dev/null
