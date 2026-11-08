# Restore the enclosing functions clauses that partial supersessions retired

Amends: [2026-10-08-ambiguous-function-boundaries.md](2026-10-08-ambiguous-function-boundaries.md), restoring clauses that partial `Supersedes:` lines retired.

Status: accepted on 2026-11-08 under step 26's audit, [issue #238](https://github.com/melian-agent/melian/issues/238).

[The boundaries decision](2026-10-08-ambiguous-function-boundaries.md) superseded [the enclosing functions decision](2026-10-07-enclosing-functions-in-the-change-prompt.md) to change only which callables a hunk on a shared boundary line carries. The index retired the target whole. The clauses below still hold on main. This file restates them and changes nothing.

## From [2026-10-07-enclosing-functions-in-the-change-prompt.md](2026-10-07-enclosing-functions-in-the-change-prompt.md)

- At a level that reads `functions`, the change prompt carries the head's function around each hunk of a TypeScript file, after the diffs, each in a `function` block of its own with numbered lines.
- The compiler finds the bounds: TypeScript 7's native syntax tree, asked through `HeadProgram`, a virtual file system holding the head's text from git.
- A callback passed to a call has no name, so the named function around it holds the hunk. A deletion's anchor is the pair of lines it sits between, and a function holds it only when it holds both.
- Every other case, a file in another language, a hunk outside any function, a function past 250 lines, a file past 512 KiB or past the first 200 TypeScript files, and blocks and the not-shown listing past 64 KiB together, stays with the instruction: the lens reads the function with `read_file`.
- The instruction says so unconditionally: the lens reads with `read_file` every hunk that has no function block, whatever the reason.
- The prompt names each case it left out, so the lens is never told a function is carried when it is not. A note says when more than 200 TypeScript files changed, when a file was past 512 KiB, when a file could not be read at the head, when the diff was cut, and when the compiler could not start.
- The notes sit outside the attach key, as the blocks do.
- A function's name keeps its first 200 bytes. The listing holds at most 100 entries and says how many more it left out.
- Function bounds come from a line table that breaks only at LF, the numbering of git's hunks and of `read_file`.
- The compiler reads text from git, never the working tree and never an author's path: the virtual files carry synthetic names Melian assigns, `/melian-head/f<n>` with the file's extension, so a path cannot reach it.
- The function text enters the prompt inside a `function` boundary with the review's nonce, as every line from the head does.
- The fingerprint renders the prompt without the blocks, and `selectionOf` holds none. A repeat call attaches to the first call's lens task. That task's stored input carries the prompt that call rendered, blocks included, so the resumed lens keeps the first call's functions. A run also stores `unread`, the reason the first call could not read the functions, and the lens's record derives its note from the stored runs, never from the finishing call's read.
- A changed function read on the same head does not re-run lenses, and `--rerun` refreshes it only when a lens failed, since only then does it replace the lens task. A new head reads fresh.
- A sweep with a heap finds each added line's innermost function in one pass over the file's sorted functions, so the cost is linear in lines and functions, never their product. Five caps bound the rest, and each leaves what it cuts to `read_file`: `anchorsPerFile` (5,000 added lines) and `callablesPerFile` (20,000 named functions) skip a file whole, `anchors` (20,000) and `callables` (100,000) skip a file that would take the files together past them, and `found` (2,000) stops taking functions. A skipped file carries no function, never a partial list.
- `enclosing()` is memoised per review, so a lens and its escalated run hold the same `unread` reason.
