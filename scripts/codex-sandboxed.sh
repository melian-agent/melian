#!/usr/bin/env bash
# Runs a Codex task in full-access mode inside a seatbelt sandbox of our own, so git, gh, and npm
# work while writes stay confined to the worktree, the git state a commit needs, scratch, and temp.
# Usage: scripts/codex-sandboxed.sh <worktree> <model> <prompt-file> [log-file] [scratch-dir]
#        scripts/codex-sandboxed.sh --print-profile <worktree> [scratch-dir]
# macOS only: it uses sandbox-exec, the seatbelt Codex itself runs on.
set -euo pipefail

# Prints the real path of $1, resolving symlinks in its directory; seatbelt matches real paths.
real() {
  local dir
  if [ -d "$1" ]; then (cd "$1" && pwd -P); return; fi
  dir=$(dirname "$1")
  if [ -d "$dir" ]; then echo "$(cd "$dir" && pwd -P)/$(basename "$1")"; else echo "$1"; fi
}

# Emits one seatbelt filter per path: (subpath) for a directory, (literal) otherwise.
filters() {
  local kind=$1 p; shift
  for p in "$@"; do
    printf '  (%s "%s")\n' "$kind" "$(real "$p")"
  done
}

# Prints the rules appended to the fixed profile. Arguments: worktree, scratch, tmpdir.
dynamic_rules() {
  local worktree=$1 scratch=$2 tmpdir=$3
  local common admin codex="$HOME/.codex" p
  common=$(real "$(cd "$worktree" && git rev-parse --path-format=absolute --git-common-dir)")
  admin=$(real "$(cd "$worktree" && git rev-parse --path-format=absolute --git-dir)")

  echo "(allow file-write*"
  for p in "$worktree" "$scratch" "$tmpdir" /private/tmp /private/var/folders "$HOME/.npm" \
    "$common/objects" "$common/refs" "$common/logs"; do
    [ -e "$p" ] && filters subpath "$p"
  done
  for p in "$common/packed-refs" "$common/packed-refs.lock"; do filters literal "$p"; done
  if [ "$admin" != "$common" ]; then
    filters subpath "$admin"
  else
    for p in HEAD HEAD.lock ORIG_HEAD ORIG_HEAD.lock FETCH_HEAD index index.lock COMMIT_EDITMSG; do
      filters literal "$common/$p"
    done
  fi
  for p in sessions log cache tmp .tmp shell_snapshots memories ipc thread-writer-locks mcp-oauth-locks attachments; do
    [ -e "$codex/$p" ] && filters subpath "$codex/$p"
  done
  for p in history.jsonl session_index.jsonl models_cache.json installation_id version.json \
    cloud-requirements-cache.json .sqlite-maintenance.lock; do
    filters literal "$codex/$p"
  done
  printf '  (regex #"^%s/[^/]+\\.sqlite(-shm|-wal)?$")\n' "$(real "$codex" | sed 's/[][\.*^$+?(){}|]/\\&/g')"
  echo ")"

  echo "(deny file-write*"
  filters subpath "$common/hooks" "$common/info"
  filters literal "$common/config" "$common/config.lock" "$admin/config.worktree" "$codex/config.toml" "$codex/auth.json"
  filters subpath "$codex/hooks"
  [ -f "$worktree/.git" ] && filters literal "$worktree/.git"
  echo ")"
}

if [ "${1:-}" = "--print-profile" ]; then
  [ $# -ge 2 ] || { echo "usage: codex-sandboxed.sh --print-profile <worktree> [scratch-dir]" >&2; exit 64; }
  worktree=$(cd "$2" && pwd -P)
  tmpdir=$(real "${TMPDIR:-/tmp}")
  scratch=${3:-${CODEX_SANDBOX_SCRATCH:-$tmpdir}}
  cat "$(cd "$(dirname "$0")" && pwd -P)/codex-seatbelt.sb"
  dynamic_rules "$worktree" "$scratch" "$tmpdir"
  exit 0
fi

if [ $# -lt 3 ]; then
  echo "usage: codex-sandboxed.sh <worktree> <model> <prompt-file> [log-file] [scratch-dir]" >&2
  exit 64
fi
if [ "$(uname -s)" != "Darwin" ]; then echo "codex-sandboxed: macOS only" >&2; exit 64; fi
worktree=$(cd "$1" && pwd -P)
model=$2
log=${4:-/dev/stdout}
[ -f "$3" ] || { echo "codex-sandboxed: prompt file not found: $3" >&2; exit 64; }
prompt=$(cat "$3")
[ -n "${prompt//[[:space:]]/}" ] || { echo "codex-sandboxed: prompt file is empty: $3" >&2; exit 64; }
log_dir=$(dirname "$log")
[ -d "$log_dir" ] || { echo "codex-sandboxed: log directory not found: $log_dir" >&2; exit 64; }
log="$(cd "$log_dir" && pwd -P)/$(basename "$log")"
tmpdir=$(real "${TMPDIR:-/tmp}")
scratch=${5:-${CODEX_SANDBOX_SCRATCH:-$tmpdir}}
profile=$(mktemp "${tmpdir%/}/codex-seatbelt.XXXXXX")
trap 'rm -f "$profile"' EXIT
"$0" --print-profile "$worktree" "$scratch" > "$profile"
cd "$worktree"
# No exec: it would replace the shell and skip the EXIT trap that removes the profile.
sandbox-exec -f "$profile" codex exec --dangerously-bypass-approvals-and-sandbox --model "$model" -C "$worktree" "$prompt" > "$log" 2>&1
