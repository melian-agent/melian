# [Issue #481](https://github.com/melian-agent/melian/issues/481): fixes from the host round at b2a8d0998

The host round on [pull request #575](https://github.com/melian-agent/melian/pull/575) at `b2a8d0998` blocked on nothing. This pass takes four of its findings, as the coordinator asked on 2026-11-20.

- `shellQuote` in `packages/cli/src/commands.ts` now writes control characters visibly with core's `visibleText` before it quotes, so a store path holding an escape sequence cannot rewrite the terminal that `melian findings --records` prints its dismiss-again command to. The test in `cli.test.ts` uses a store path holding `ESC[2J`. Against the head before the fix it failed with `expected 'melian: finding 8989ad96980aceae is l…' not to contain '\u001b'`; after it, it passed.
- The same command printed `--reason <text>` bare, and a shell reads `<text>` as a redirect from a file named `text`. It now prints `"<text>"`, as the coordinator asked on 2026-11-20. The quoting test in `cli.test.ts` now runs the printed command through bash and compares the argument list. Against the head before the fix it failed with `bash: line 1: text: No such file or directory`; after it, it passed.
- The TSDoc of `records` in `packages/pipeline/src/dismiss.ts` said a dismissal made with no store waits for a later export. It now says no record is written, and an export names the dismissal unshared, as `madeWithoutStore`.
- The one-revision decision restates every clause of the frontier decision it supersedes that still stands, and names a limit: two dismissals made at once both stand and decide, and only the latest reason is shown. [Issue #621](https://github.com/melian-agent/melian/issues/621) holds the change that would show both, which alters the stored finding's shape.
- The progress-log entries of this pull request link the issues they name.

No file this pass changes guards trust or durability: `shellQuote` shapes a suggested command, and the rest is documentation.
