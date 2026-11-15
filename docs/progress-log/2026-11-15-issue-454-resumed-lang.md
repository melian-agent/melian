[Issue #454](https://github.com/melian-agent/melian/issues/454), fix pass for Codex's adversarial review. Codex found that a resumed check task could run its tools under another `LANG` than its key read. `runChecks` keys the run with the process's `LANG`; a crash leaves the task pending; a shell with another locale resumes it, Stryker runs the head's tests under the new locale, and the result is recorded under the first key.

The check tasks now store the `LANG` the key read, `melian.checks` and `melian.check` each in an optional `lang` field of their input, and `toolEnvironment` in `packages/pipeline/src/static.ts` passes that value to every command in place of the process's. An input a build before this one stored has no `lang`, and its tools run with the process's `LANG`, as before. The field is optional and its absence keeps the old behaviour, so neither task's version changes. `test/fixtures/migrations-from-version/check-v3.json`, recorded by main at `088aa41f`, is a `melian.check` input of version 3 with no `lang`, and the reopen test stores it in SQLite through a version-3 token and resumes it with today's `checksExtension`.

`packages/pipeline/test/check-lang.test.ts` moves the process to `C.UTF-8` once the first tool runs, as a resume in another shell would. At `b57b759f`, before the fix, two of its three tests failed for the reported reason:

- "is the one the run's key read, whatever the process holds by the time the tools run": `expected Set{ 'en_AU.UTF-8', 'C.UTF-8' } to deeply equal Set{ 'en_AU.UTF-8' }`.
- "is none when the key read none, though the process has one by then": `expected Set{ undefined, 'C.UTF-8' } to deeply equal Set{ undefined }`.

The third, "is the process's for a check main stored before its input carried one", passed there, as it should: it pins the fallback. After the fix all three passed.

The wider class, a resumed task running on host facts and an install other than those its key read, is [issue #459](https://github.com/melian-agent/melian/issues/459). Only `LANG` can travel with the task. The amendment now states that window as a limit, which the maintainer accepted on 2026-11-15, in the coordinator's session. He also ruled there that a mutation result is reused only on the host that ran it, and that a shared record never carries one across hosts; the note on [issue #425](https://github.com/melian-agent/melian/issues/425#issuecomment-6889208295) says what its export or import must do.

[The inventory](2026-11-15-issue-454-resumed-lang-mutants.json), version 2 over `b57b759f...2790f52b` with `--claims-in` for `checks.ts`, lists ten mutants. At `2790f52b`, each named test passed unmutated first. Then a scratch script applied each mutant and ran its named test alone:

- Seven were killed by "is the one the run's key read, whatever the process holds by the time the tools run".
- One, `688:20`, empties `{ base, head, tier, policy }`, an older literal on the changed line. It was killed by `checks.test.ts`'s "runs again rather than reuse a run from a build that stored Biome and tsc text", which reads the run's policy.
- Two are equivalent, the `false` forms of the spreads at lines 249 and 550. `runStaticTool` reads an absent and an undefined `lang` alike, and Pi Durable copies a task input with `omitUndefinedProperties`.

The enumerator leaves `static.ts` unmutated, because the file sends process signals. `toolEnvironment` sends none, so nine mutants of its new lines were applied by hand, and each failed its named test:

- Five mutants of the `LANG` condition, each killed by the first test: forced false, forced true, `||`, `lang === undefined` and `name !== "LANG"`.
- `lang !== undefined` forced true, killed by "is the process's for a check main stored before its input carried one".
- Dropping the null check, and `&&` to `||` in it, killed by "is none when the key read none, though the process has one by then".
- `toolEnvironment()` in place of `toolEnvironment(this.input.lang)`, killed by the first test.
