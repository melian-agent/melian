# Shared function boundaries carry every plausible scope

Supersedes: [2026-10-07-enclosing-functions-in-the-change-prompt.md](2026-10-07-enclosing-functions-in-the-change-prompt.md), only the choice at a shared boundary line.

Problem: git gives changed lines, without columns. An edit to `outer` in `function outer() { const inner = () => {` could belong to either function. Choosing `inner` hides the tail of `outer`.

Choice: carry the innermost callable and every callable whose opening or closing line meets the anchor and whose span holds the whole anchor. Interior edits still carry the innermost callable alone. Existing line, byte and function caps apply; omitted scopes remain listed or covered by the cap note and the instruction to read them. One block suffices for identical line spans.

Carrying every plausible scope avoids an extra read when the existing caps allow it. Dropping all blocks would be safe but spends the lens's tools on text already available.

Once the found cap refuses a scope, extraction stops asking the compiler for later files. Their omitted scopes remain covered by the cap note.
