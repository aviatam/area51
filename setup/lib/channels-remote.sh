# Resolve an explicitly configured or Area51-owned registry remote, and verify
# that its requested branch is actually readable before applying any payload.
# Never add remotes or fall back to the former upstream automatically.
# AREA51_CHANNELS_REMOTE=<existing-remote> also configures provider registries.
resolve_channels_remote() {
  local branch="${1:-channels}" remote="${AREA51_CHANNELS_REMOTE:-}" candidate url
  case "$branch" in
    channels|providers) ;;
    *) printf '%s\n' 'Unsupported registry branch.' >&2; return 1 ;;
  esac

  if [ -z "$remote" ]; then
    while IFS=$'\t' read -r candidate url; do
      case "$url" in
        https://github.com/aviatam/area51|https://github.com/aviatam/area51.git|git@github.com:aviatam/area51.git|ssh://git@github.com/aviatam/area51.git)
          remote="$candidate"; break ;;
      esac
    done < <(git remote -v 2>/dev/null | awk '$3 == "(fetch)" { print $1"\t"$2 }')
  fi
  if [[ ! "$remote" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]; then
    printf '%s\n' 'No registry remote configured, or its name is invalid. Set AREA51_CHANNELS_REMOTE to a safe existing remote name. See docs/registry-sources.md.' >&2
    return 1
  fi
  if ! git remote get-url "$remote" >/dev/null 2>&1; then
    printf '%s\n' 'No registry remote configured. Set AREA51_CHANNELS_REMOTE to an existing trusted Git remote carrying channels/providers. See docs/registry-sources.md.' >&2
    return 1
  fi
  if ! GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code --heads "$remote" "refs/heads/$branch" >/dev/null 2>&1; then
    printf 'Registry branch %s is absent or inaccessible on remote %s. No first-party registry branches are currently published. Configure AREA51_CHANNELS_REMOTE to a trusted readable source; see docs/registry-sources.md.\n' "$branch" "$remote" >&2
    return 1
  fi
  printf '%s' "$remote"
}
