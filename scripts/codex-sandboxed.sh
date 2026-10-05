#!/usr/bin/env bash
# Runs a Codex task in full-access mode inside a seatbelt sandbox of our own, so git, gh, and npm
# work while writes stay confined to the worktree, the git state a commit needs, scratch, and temp.
# Usage: scripts/codex-sandboxed.sh <worktree> <model> <prompt-file> [log-file] [scratch-dir]
#        scripts/codex-sandboxed.sh --print-profile <worktree> [scratch-dir]
# macOS only: it uses sandbox-exec, the seatbelt Codex itself runs on.
set -euo pipefail

# CODEX_HOME relocates Codex's state directory, and CODEX_* passes through to the task.
codex_home=${CODEX_HOME:-$HOME/.codex}
case $codex_home in
  /*) ;;
  *) echo "codex-sandboxed: CODEX_HOME must be an absolute path: $codex_home" >&2; exit 64 ;;
esac

# The Codex subdirectories the profile allows, the deny covers, and the wrapper creates.
codex_names=(sessions log cache tmp ipc thread-writer-locks mcp-oauth-locks attachments)

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

# Prints the real path of $1 escaped for a seatbelt regex.
regex_path() {
  local r
  r=$(real "$1")
  check_path "$r"
  printf '%s\n' "$r" | sed 's/[][\.*^$+?(){}|]/\\&/g'
}

check_codex_paths() {
  local p
  if [ -L "$codex_home" ]; then
    echo "codex-sandboxed: Codex home is a symlink: $codex_home" >&2
    exit 64
  fi
  codex_home=$(real "$codex_home")
  for p in "${codex_names[@]}" auth.json; do
    if [ -L "$codex_home/$p" ] || [ "$(real "$codex_home/$p")" != "$codex_home/$p" ]; then
      echo "codex-sandboxed: Codex path is a symlink or resolves outside its home: $codex_home/$p" >&2
      exit 64
    fi
  done
}

filters() {
  local kind=$1 p r; shift
  for p in "$@"; do
    r=$(real "$p")
    check_path "$r"
    printf '  (%s "%s")\n' "$kind" "$r"
  done
}

# Only a linked worktree is allowed: the main checkout's worktree allowance would cover its .git, which a task could rename.
dynamic_rules() {
  local worktree=$1 scratch=$2 run=$3
  local common admin codex=$codex_home p
  common=$(real "$(cd "$worktree" && git rev-parse --path-format=absolute --git-common-dir)")
  admin=$(real "$(cd "$worktree" && git rev-parse --path-format=absolute --git-dir)")
  if [ "$admin" = "$common" ] || [ ! -f "$worktree/.git" ]; then
    echo "codex-sandboxed: $worktree is not a linked worktree; run from one beside the checkout (git worktree add)" >&2
    exit 64
  fi

  echo "(allow file-write*"
  {
    filters subpath "$worktree" "$scratch" "$run" "$common/objects" "$common/refs" "$common/logs"
    # gc.pid and shallow live in the common directory, even in a linked worktree.
    filters literal "$common/packed-refs" "$common/packed-refs.lock" "$common/gc.pid" "$common/gc.pid.lock" \
      "$common/shallow" "$common/shallow.lock"
    for p in HEAD ORIG_HEAD FETCH_HEAD MERGE_HEAD MERGE_MSG MERGE_MODE AUTO_MERGE CHERRY_PICK_HEAD \
      REVERT_HEAD SQUASH_MSG COMMIT_EDITMSG index; do
      filters literal "$admin/$p" "$admin/$p.lock"
    done
    filters subpath "$admin/logs" "$admin/sequencer"
    # git commit <paths> and git commit --only lock next-index-<pid>.lock; git stash writes index.stash.<pid> and its .lock.
    printf '  (regex #"^%s/next-index-[0-9]+\\.lock$")\n' "$(regex_path "$admin")"
    printf '  (regex #"^%s/index\\.stash\\.[0-9]+(\\.lock)?$")\n' "$(regex_path "$admin")"
    for p in "${codex_names[@]}"; do
      printf '  (regex #"^%s/%s/")\n' "$(regex_path "$codex")" "$p"
    done
    for p in history.jsonl session_index.jsonl models_cache.json installation_id version.json \
      cloud-requirements-cache.json .sqlite-maintenance.lock; do
      filters literal "$codex/$p"
    done
    check_path "$(real "$codex")"
    # Codex rewrites auth.json when it refreshes a ChatGPT login, so a task must be able to write it,
    # and a temporary beside it that Codex renames over it, whatever name the binary gives it.
    printf '  (regex #"^%s/(auth\\.json([.][^/]*)?|[.]tmp[^/]+)$")\n' "$(regex_path "$codex")"
    printf '  (regex #"^%s/[^/]+\\.sqlite(-shm|-wal)?$")\n' "$(real "$codex" | sed 's/[][\.*^$+?(){}|]/\\&/g')"
  } | awk '!seen[$0]++'
  echo ")"

  # No path may lead from the worktree to a directory outside it, such as the per-run directory,
  # which a process that outlives the wrapper could refill after it deletes the directory. A symlink under
  # node_modules is allowed, since npm links each package's bin there. These rules come before the
  # denies below, so those still win for a link named HEAD or commondir. chflags would make a planted
  # file immune to the wrapper's rm -rf.
  printf '(deny file-write-create\n  (require-all\n    (subpath "%s")\n    (vnode-type SYMLINK)))\n' "$worktree"
  printf '(allow file-write-create\n  (require-all\n    (regex #"^%s/(.*/)?node_modules/")\n    (vnode-type SYMLINK)))\n' "$(regex_path "$worktree")"
  printf '(deny file-write-create\n  (require-all\n    (subpath "%s")\n    (vnode-type SYMLINK)))\n' "$codex"
  echo "(deny file-write-flags)"

  echo "(deny file-write*"
  filters subpath "$common/hooks" "$common/info"
  filters literal "$common/config" "$common/config.lock" "$admin/commondir" "$admin/gitdir" "$admin/locked" \
    "$admin/config.worktree" "$codex/config.toml"
  filters subpath "$codex/hooks"
  # No allowed subtree may hold a repository a host could later enter through a symlink. A repository
  # needs a .git directory, or a HEAD file that sits beside objects/ and refs/ or beside a commondir
  # file naming a directory that holds them, and its config could run a program.
  # Each name is spelt out in both cases: APFS ignores case, and git finds "<dir>/.GIT".
  # The run directory needs no deny: the wrapper removes it on exit, so a repository planted there is gone
  # before the host could enter it. A scratch directory apart from it persists, so it keeps the deny.
  local codex_dirs=() persistent=("$worktree") d
  if [ "$(real "$scratch")" != "$(real "$run")" ]; then persistent+=("$scratch"); fi
  for d in "${codex_names[@]}"; do codex_dirs+=("$codex/$d"); done
  local trees=("${persistent[@]}" "$common/objects" "$common/refs" "$common/logs" "$admin/logs" "$admin/sequencer" \
    ${codex_dirs[@]+"${codex_dirs[@]}"})
  {
    for p in "${trees[@]}"; do
      printf '  (regex #"^%s/(.*/)?[.][gG][iI][tT](/|$)")\n' "$(regex_path "$p")"
    done
    # The remote HEAD allowance below makes refs/remotes/<name> a place git may write HEAD, so a
    # repository there still needs objects/; deny that directory, whose name only a remote branch could use.
    printf '  (regex #"^%s/(logs/)?refs/remotes/[^/]+/[oO][bB][jJ][eE][cC][tT][sS](/|$)")\n' "$(regex_path "$common")"
    # Git writes only todo, head, abort-safety, and opts in sequencer/, but its head file stays writable below,
    # so a repository there needs a refs/ or objects/ the deny keeps out; the profile matches names without regard to case.
    printf '  (regex #"^%s/sequencer/(.*/)?([oO][bB][jJ][eE][cC][tT][sS]|[rR][eE][fF][sS])(/|$)")\n' "$(regex_path "$admin")"
  } | awk '!seen[$0]++'
  echo ")"

  # A directory may be named head or commondir: the deny covers anything that is not a directory,
  # so a task cannot create, write, link, or rename a file with either name, and git's own writes follow it.
  echo "(deny file-write-create file-write-data file-write-unlink"
  echo "  (require-all"
  echo "    (require-any"
  {
    for p in "${trees[@]}"; do
      printf '      (regex #"^%s/(.*/)?([hH][eE][aA][dD]|[cC][oO][mM][mM][oO][nN][dD][iI][rR])$")\n' "$(regex_path "$p")"
    done
  } | awk '!seen[$0]++'
  echo "    )"
  echo "    (require-not (vnode-type DIRECTORY))"
  echo "  )"
  echo ")"

  # The HEAD files git itself writes under the denied trees. They come after the deny, which wins
  # otherwise, and name the same operations: a rule on a specific operation outranks one on file-write*.
  echo "(allow file-write-create file-write-data file-write-unlink"
  filters literal "$common/logs/HEAD" "$common/logs/HEAD.lock" "$admin/logs/HEAD" "$admin/logs/HEAD.lock"
  printf '  (regex #"^%s/refs/remotes/[^/]+/HEAD([.]lock)?$")\n' "$(regex_path "$common")"
  printf '  (regex #"^%s/logs/refs/remotes/[^/]+/HEAD([.]lock)?$")\n' "$(regex_path "$common")"
  # Melian's own CLI writes refs/melian/pull/<N>/head for every pull-request review.
  printf '  (regex #"^%s/refs/melian/(.*/)?head([.]lock)?$")\n' "$(regex_path "$common")"
  # git cherry-pick and revert of several commits keep their position in sequencer/head. The profile's regexes
  # match without regard to case on APFS, so this also opens sequencer/HEAD.
  printf '  (regex #"^%s/sequencer/head([.]lock)?$")\n' "$(regex_path "$admin")"
  printf '  (regex #"^%s/logs/refs/melian/(.*/)?head([.]lock)?$")\n' "$(regex_path "$common")"
  echo ")"

  echo "(deny file-write*"
  printf '  (literal "%s/.env")\n' "$worktree"
  filters literal "$worktree/.env"
  if [ "$(basename "$common")" = ".git" ]; then
    printf '  (literal "%s/.env")\n' "$(dirname "$common")"
    filters literal "$(dirname "$common")/.env"
  fi
  echo ")"

  echo "(deny file-read*"
  filters subpath "$HOME/.ssh" "$common/melian" "$worktree/.git/melian"
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
  check_codex_paths
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
check_codex_paths
profile=$(mktemp "${tmpdir%/}/codex-seatbelt.XXXXXX")
run=$(real "$(mktemp -d "${tmpdir%/}/codex-run.XXXXXX")")
# The task runs in its own process group (job control), and the trap kills the group, so a background
# child that outlives codex cannot refill the run directory after it is deleted.
child=
cleanup() {
  [ -z "$child" ] || kill -KILL -- "-$child" 2>/dev/null || true
  rm -rf "$profile" "$run"
}
trap cleanup EXIT
trap 'exit 143' INT TERM
scratch=${5:-${CODEX_SANDBOX_SCRATCH:-$run}}
# Create scratch before resolving it: real leaves a path unchanged when its parent is missing, and
# npm would resolve a relative cache path inside the worktree.
mkdir -p "$scratch/npm-cache" "$scratch/melian"
scratch=$(real "$scratch")
# Codex fails on a first run if these are missing, and the profile allows only what exists by name.
# Create them before the profile: real leaves a path unchanged when its parent is missing.
for d in "${codex_names[@]}"; do mkdir -p "$codex_home/$d"; done
codex_home=$(real "$codex_home")
CODEX_HOME="$codex_home" "$0" --print-profile "$worktree" "$scratch" "$run" > "$profile"

# TMPPREFIX is where zsh writes here-documents; its /tmp/zsh default is closed, and Codex runs every command as zsh -lc.
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
# Backgrounded under set -m, the command leads a process group of its own, and wait returns its status.
# stdin is /dev/null: codex exec reads a piped stdin as extra input and stalls waiting for it.
# The prompt follows --, so one that starts with a dash is not read as an option.
set -m
sandbox-exec -f "$profile" env -i ${allowed[@]+"${allowed[@]}"} TMPDIR="$run" TMPPREFIX="$run/zsh" npm_config_cache="$scratch/npm-cache" MELIAN_STATE_DIR="$scratch/melian" \
  codex exec --dangerously-bypass-approvals-and-sandbox --model "$model" -C "$worktree" -- "$prompt" < /dev/null > "$log" 2>&1 &
child=$!
status=0
wait "$child" || status=$?
exit "$status"
