#!/usr/bin/env bash
# Runs a Codex task in full-access mode inside a seatbelt sandbox of our own, so git, gh, and npm
# work while writes stay confined to the worktree, its git directory, scratch, temp, and caches.
# Usage: scripts/codex-sandboxed.sh <worktree> <model> <prompt-file> [log-file] [scratch-dir]
# macOS only: it uses sandbox-exec, the seatbelt Codex itself runs on.
set -euo pipefail
worktree=$(cd "$1" && pwd -P)
model=$2
prompt_file=$3
log=${4:-/dev/stdout}
if [ "$(uname -s)" != "Darwin" ]; then echo "codex-sandboxed: macOS only" >&2; exit 64; fi
gitdir=$(cd "$worktree" && git rev-parse --path-format=absolute --git-common-dir)
tmpdir=${TMPDIR:-/tmp}
scratch=${5:-${CODEX_SANDBOX_SCRATCH:-$tmpdir}}
profile=$(mktemp "${tmpdir%/}/codex-seatbelt.XXXXXX")
writable_file=$(mktemp "${tmpdir%/}/codex-seatbelt-paths.XXXXXX")
trap 'rm -f "$profile" "$writable_file"' EXIT
here=$(cd "$(dirname "$0")" && pwd -P)
writable=""
for p in "$worktree" "$gitdir" "$scratch" "$tmpdir" /private/tmp /private/var/folders "$HOME/.codex" "$HOME/.npm" "$HOME/.cache" "$HOME/.config/gh" "$HOME/Library/Caches" "$HOME/Library/Application Support/com.apple.sharedfilelist"; do
  [ -e "$p" ] || continue
  real=$(cd "$p" 2>/dev/null && pwd -P || echo "$p")
  writable+="  (subpath \"$real\")"$'\n'
done
printf '%s' "$writable" > "$writable_file"
awk -v f="$writable_file" '{ if ($0 == "@@WRITABLE@@") { while ((getline line < f) > 0) print line; close(f) } else print }' "$here/codex-seatbelt.sb" > "$profile"
cd "$worktree"
# No exec: it would replace the shell and skip the EXIT trap that removes the profile.
sandbox-exec -f "$profile" codex exec --dangerously-bypass-approvals-and-sandbox --model "$model" -C "$worktree" "$(cat "$prompt_file")" > "$log" 2>&1
