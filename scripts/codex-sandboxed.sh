#!/usr/bin/env bash
# Runs a Codex task in full-access mode inside a seatbelt sandbox of our own, so git, gh, and npm
# work while writes stay confined to the worktree, the git state a commit needs, scratch, and temp.
# Usage: scripts/codex-sandboxed.sh <worktree> <model> <prompt-file> [log-file] [scratch-dir]
#        scripts/codex-sandboxed.sh --print-profile <worktree> [scratch-dir]
# macOS only: it uses sandbox-exec, the seatbelt Codex itself runs on.
set -euo pipefail

# Prints the real path of $1, resolving symlinks in its directory and in its last component;
# seatbelt matches real paths, so a filter naming a link would miss its target.
real() {
  local p=$1 dir target hops=0
  while [ -L "$p" ] && [ "$hops" -lt 40 ]; do
    dir=$(cd "$(dirname "$p")" && pwd -P)
    target=$(readlink "$p")
    case $target in /*) p=$target ;; *) p=$dir/$target ;; esac
    hops=$((hops + 1))
  done
  if [ -d "$p" ]; then (cd "$p" && pwd -P); return; fi
  dir=$(dirname "$p")
  if [ -d "$dir" ]; then echo "$(cd "$dir" && pwd -P)/$(basename "$p")"; else echo "$p"; fi
}

# Exits 64 on a path with a backslash, double quote, or newline: it would break out of a profile string.
check_path() {
  case $1 in
    *[\\\"]* | *$'\n'*) echo "codex-sandboxed: path holds a backslash, quote, or newline: $1" >&2; exit 64 ;;
  esac
}

# Emits one seatbelt filter per path: (subpath) for a directory, (literal) otherwise.
filters() {
  local kind=$1 p r; shift
  for p in "$@"; do
    r=$(real "$p")
    check_path "$r"
    printf '  (%s "%s")\n' "$kind" "$r"
  done
}

# Prints the rules appended to the fixed profile: write allowances, then write and read denials.
# Arguments: worktree, scratch, run directory. Only a linked worktree is allowed: the main checkout's
# worktree allowance would cover its .git, and a task could rename it and put its own in place.
dynamic_rules() {
  local worktree=$1 scratch=$2 run=$3
  local common admin codex="$HOME/.codex" p
  common=$(real "$(cd "$worktree" && git rev-parse --path-format=absolute --git-common-dir)")
  admin=$(real "$(cd "$worktree" && git rev-parse --path-format=absolute --git-dir)")
  if [ "$admin" = "$common" ] || [ ! -f "$worktree/.git" ]; then
    echo "codex-sandboxed: $worktree is not a linked worktree; run from one beside the checkout (git worktree add)" >&2
    exit 64
  fi

  echo "(allow file-write*"
  {
    filters subpath "$worktree" "$scratch" "$run" "$common/objects" "$common/refs" "$common/logs"
    filters literal "$common/packed-refs" "$common/packed-refs.lock"
    for p in HEAD ORIG_HEAD FETCH_HEAD MERGE_HEAD MERGE_MSG MERGE_MODE AUTO_MERGE CHERRY_PICK_HEAD \
      REVERT_HEAD COMMIT_EDITMSG index gc.pid shallow; do
      filters literal "$admin/$p" "$admin/$p.lock"
    done
    filters subpath "$admin/logs"
    for p in sessions log cache tmp ipc thread-writer-locks mcp-oauth-locks attachments; do
      filters subpath "$codex/$p"
    done
    for p in history.jsonl session_index.jsonl models_cache.json installation_id version.json \
      cloud-requirements-cache.json .sqlite-maintenance.lock; do
      filters literal "$codex/$p"
    done
    check_path "$(real "$codex")"
    printf '  (regex #"^%s/[^/]+\\.sqlite(-shm|-wal)?$")\n' "$(real "$codex" | sed 's/[][\.*^$+?(){}|]/\\&/g')"
  } | awk '!seen[$0]++'
  echo ")"

  echo "(deny file-write*"
  filters subpath "$common/hooks" "$common/info"
  filters literal "$common/config" "$common/config.lock" "$admin/commondir" "$admin/gitdir" "$admin/locked" \
    "$admin/config.worktree" "$worktree/.git" "$codex/config.toml" "$codex/auth.json"
  filters subpath "$codex/hooks"
  printf '  (regex #"^%s/.*/\\.git(/|$)")\n' "$(real "$worktree" | sed 's/[][\.*^$+?(){}|]/\\&/g')"
  echo ")"

  echo "(deny file-read*"
  filters subpath "$HOME/.ssh"
  filters literal "$HOME/.pi/agent/auth.json" "$HOME/.npmrc" "$worktree/.env"
  [ "$(basename "$common")" = ".git" ] && filters literal "$(dirname "$common")/.env"
  echo ")"
}

if [ "${1:-}" = "--print-profile" ]; then
  [ $# -ge 2 ] || { echo "usage: codex-sandboxed.sh --print-profile <worktree> [scratch-dir [run-dir]]" >&2; exit 64; }
  worktree=$(cd "$2" && pwd -P)
  tmpdir=$(real "${TMPDIR:-/tmp}")
  run=${4:-$tmpdir/codex-run}
  scratch=${3:-${CODEX_SANDBOX_SCRATCH:-$run}}
  cat "$(cd "$(dirname "$0")" && pwd -P)/codex-seatbelt.sb"
  dynamic_rules "$worktree" "$scratch" "$run"
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
profile=$(mktemp "${tmpdir%/}/codex-seatbelt.XXXXXX")
run=$(real "$(mktemp -d "${tmpdir%/}/codex-run.XXXXXX")")
trap 'rm -rf "$profile" "$run"' EXIT
scratch=${5:-${CODEX_SANDBOX_SCRATCH:-$run}}
# Create scratch before resolving it: real leaves a path unchanged when its parent is missing, and
# npm would resolve a relative cache path inside the worktree.
mkdir -p "$scratch/npm-cache"
scratch=$(real "$scratch")
"$0" --print-profile "$worktree" "$scratch" "$run" > "$profile"
# Codex fails on a first run if these are missing, and the profile allows only what exists by name.
for d in sessions log cache tmp ipc thread-writer-locks mcp-oauth-locks attachments; do mkdir -p "$HOME/.codex/$d"; done

# The sandbox confines writes, not secrets; pass only what a task needs and drop the rest, so an
# agent socket, cloud credentials, tokens, and npm settings never reach it.
allowed=()
while IFS= read -r name; do
  case $name in
    PATH | HOME | USER | LOGNAME | SHELL | TERM | LANG | LC_* | TZ | EDITOR | CODEX_* | GIT_AUTHOR_* | GIT_COMMITTER_*)
      allowed+=("$name=${!name}") ;;
  esac
done < <(compgen -e)

cd "$worktree"
# No exec: it would replace the shell and skip the EXIT trap that removes the profile and run directory.
# stdin is /dev/null: codex exec reads a piped stdin as extra input and stalls waiting for it.
# The prompt follows --, so one that starts with a dash is not read as an option.
sandbox-exec -f "$profile" env -i ${allowed[@]+"${allowed[@]}"} TMPDIR="$run" npm_config_cache="$scratch/npm-cache" \
  codex exec --dangerously-bypass-approvals-and-sandbox --model "$model" -C "$worktree" -- "$prompt" < /dev/null > "$log" 2>&1
