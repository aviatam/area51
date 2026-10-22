# channels-remote.sh — resolve the git remote that carries the `channels`
# branch. Source this file and call `resolve_channels_remote`; echoes the
# remote name (e.g. `origin` or `upstream`).
#
# Typical fork setups keep the upstream area51 repo under a remote named
# `upstream`, with `origin` pointing at the user's fork. The channels branch
# only lives upstream, so a hardcoded `git fetch origin channels` fails for
# forks. This helper walks `git remote -v`, picks the remote whose URL points
# at aviatam/area51, and prints its name.
#
# Fallback: if no existing remote matches, add `area51-source` pointing at
# github.com/aviatam/area51 and return that — keeps forks without an
# explicit upstream configured working on the first try.
#
# Explicit override: set AREA51_CHANNELS_REMOTE=<name> to skip detection.

resolve_channels_remote() {
  if [ -n "${AREA51_CHANNELS_REMOTE:-}" ]; then
    printf '%s' "$AREA51_CHANNELS_REMOTE"
    return 0
  fi

  # Anchor the repo-name tail: the pattern must match the area51 repo itself,
  # never a sibling channel repo like qwibitai/area51-discord (which carries
  # no channels branch — an unanchored `*area51*` glob picked those on
  # multi-remote machines and broke every from-branch copy).
  local remote url
  while IFS=$'\t' read -r remote url; do
    case "$url" in
      https://github.com/aviatam/area51|https://github.com/aviatam/area51.git|git@github.com:aviatam/area51.git|ssh://git@github.com/aviatam/area51.git)
        printf '%s' "$remote"
        return 0
        ;;
    esac
  done < <(git remote -v 2>/dev/null | awk '$3 == "(fetch)" { print $1"\t"$2 }')

  # No matching remote — preserve unrelated remotes and add an owned source.
  # Never reuse an existing upstream remote: it may still point at NanoClaw.
  if git remote get-url area51-source >/dev/null 2>&1; then
    printf '%s\n' 'area51-source exists but does not point at aviatam/area51; review its URL.' >&2
    return 1
  fi
  git remote add area51-source https://github.com/aviatam/area51.git || return 1
  printf '%s' "area51-source"
}
