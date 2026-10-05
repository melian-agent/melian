# Goldens still to write

The comparison records in [../comparisons/](../comparisons/) mark each accepted finding that should become a golden. Milestone 2 step 3 wrote five goldens for each of the five lenses it added, twenty-five in all, each with a README naming the finding it came from. This list holds the rest, grouped by the lens that should catch each, so a scripted golden can be written for any of them without reading every record again.

Each entry names the record's finding number and what it found. A finding that restates another, or that a record marks "No", is left out. The record for [pull request #31](https://github.com/melian-agent/melian/pull/31) marks no goldens: every finding there is about documentation no lens reviewed.

## trust-boundary

- [Pull request #10](https://github.com/melian-agent/melian/pull/10) ([record](../comparisons/2026-10-03-pr-10.md)): 1, `min-release-age` is inert under npm 10; 3, the pinned-deps script lets `*` through; 11, `npm ci` ignores the quarantine, so a fresh release passes the gate.
- [Pull request #12](https://github.com/melian-agent/melian/pull/12) ([record](../comparisons/2026-10-03-pr-12.md)): 11, `loadStandards` reads the head's standards into its own lens prompts; 12, `diff.ignoreSubmodules` or a `.gitmodules` ignore hides a pointer change; 13, `--name-status` hides mode changes; 15, git inherits a hook's `GIT_DIR` and reads the hook's repository; 17, git reads the head's `.gitattributes`, so `*.ts -diff` hides its own hunks; 19, a YAML alias bomb throws a bare `ReferenceError`; 20, lens paths with `..` climb out of the repository.
- [Pull request #13](https://github.com/melian-agent/melian/pull/13) ([record](../comparisons/2026-10-03-pr-13.md)): 8, a newline in a rule ID forges another finding's header; 15, a lens chooses its own finding's resolution, status, and cause.
- [Pull request #15](https://github.com/melian-agent/melian/pull/15) ([record](../comparisons/2026-10-03-pr-15.md)): A4, prose evidence promotes any finding to `affected`; B1, a path holding a newline forges a prompt line; B6, `git grep` without `--attr-source` lets a head hide its files from search; B10, a file name forges search matches and listing entries.
- [Pull request #16](https://github.com/melian-agent/melian/pull/16) ([record](../comparisons/2026-10-03-pr-16.md)): B11, a message's continuation lines forge a finding header.
- [Pull request #18](https://github.com/melian-agent/melian/pull/18) ([record](../comparisons/2026-10-03-pr-18.md)): A1, a head that turns a directory into a file poisons the configuration cache; A3, a quoted literal type rewrites a tsc result's path and rule; A4, one NUL byte stops forbidden-patterns scanning a file; A7 and B1, a tracked `node_modules/.bin/tsc` runs; A14, `readOutput` reads through symlinks; B2, a head switches off the analysers that judge it; C6, a solution-style `tsconfig.json` checks nothing and reads as clean; C10, a rename brings a file into a rule's scope unscanned.
- [Pull request #19](https://github.com/melian-agent/melian/pull/19) ([record](../comparisons/2026-10-03-pr-19.md)): A1, a marker is trusted by its author rather than a signature; A2 and B6, a range review's verdict lands in the pull request's storage; B5, finding text renders as live markdown in the maintainer's voice.
- [Pull request #21](https://github.com/melian-agent/melian/pull/21) ([record](../comparisons/2026-10-03-pr-21.md)): A1, the skill builds and runs the checkout's own `melian`.

## removed-behaviour

- [Pull request #18](https://github.com/melian-agent/melian/pull/18) ([record](../comparisons/2026-10-03-pr-18.md)): C4, cleanup ran under a cancelled context and an abort read as `toolFailed`, extending A5.

## tests

- [Pull request #11](https://github.com/melian-agent/melian/pull/11) ([record](../comparisons/2026-10-03-pr-11.md)): 1, a crash log read mid-append throws and the parked child is never killed; 2, the boundary test gates Pi Durable and Chord but not pi-ai; 3, a test takes the last transcript entry as the lens's answer; 6, `crashWhen` misses a child killed by a signal; 7, `field()` returns undefined for a missing field instead of failing.
- [Pull request #12](https://github.com/melian-agent/melian/pull/12) ([record](../comparisons/2026-10-03-pr-12.md)): 26, the boundary guards miss side-effect and dynamic imports and `.mts` files.
- [Pull request #15](https://github.com/melian-agent/melian/pull/15) ([record](../comparisons/2026-10-03-pr-15.md)): B15, scripted goldens never check tool results.
- [Pull request #21](https://github.com/melian-agent/melian/pull/21) ([record](../comparisons/2026-10-03-pr-21.md)): B1, the skills test must fail an edit that restores the build-and-run fallback.

## conventions

- [Pull request #10](https://github.com/melian-agent/melian/pull/10) ([record](../comparisons/2026-10-03-pr-10.md)): 6, `AGENTS.md` promises guidance files that do not exist; 8, the plan leaves a finished track unticked.
- [Pull request #12](https://github.com/melian-agent/melian/pull/12) ([record](../comparisons/2026-10-03-pr-12.md)): 24, the design says two things about where standards live.

## durability

A repository lens under Melian's own `.melian/lenses/`. A scripted golden for it carries a copy of the lens as `.melian/lenses/durability/LENS.golden.md` in both trees, as its five goldens do.

- [Pull request #13](https://github.com/melian-agent/melian/pull/13) ([record](../comparisons/2026-10-03-pr-13.md)): 4, a rerun's whole-record upsert erases a dismissal; 23, the findings document's owning conversation is unstated.
- [Pull request #15](https://github.com/melian-agent/melian/pull/15) ([record](../comparisons/2026-10-03-pr-15.md)): A2, one mutable record per finding races across lenses and pushes; A3, the budget check blocks a replay; B2, a crash runs every lens twice.
- [Pull request #16](https://github.com/melian-agent/melian/pull/16) ([record](../comparisons/2026-10-03-pr-16.md)): A5, an aborted task poisons every repeat review; B6, a review after a dismissal returns the verdict from before it; B8, a failed adjudication is attached to for good.
- [Pull request #18](https://github.com/melian-agent/melian/pull/18) ([record](../comparisons/2026-10-03-pr-18.md)): B5, a `fast` and a `full` run mix their records.
- [Pull request #19](https://github.com/melian-agent/melian/pull/19) ([record](../comparisons/2026-10-03-pr-19.md)): B1, a failed round's placeholder reposts findings; B7, recovery matches an older review with the same verdict.
- [Pull request #34](https://github.com/melian-agent/melian/pull/34) ([record](../comparisons/2026-10-04-pr-34.md)): A3, author-controlled input stored durably with no byte bound; A4, a retarget that keeps the head and the findings posts nothing; D1 to D3, a dismissal must survive a fresh sighting through a hunk over 2 KiB.
- [Pull request #50](https://github.com/melian-agent/melian/pull/50) ([record](../comparisons/2026-10-05-pr-50.md)): A1, a change that reshapes a finished task's result while a reader can still meet one an older Melian stored, expected `stored-shape`; A2, as a negative golden, a change that leaves an optional member `undefined` in a task's input or result, expected to draw nothing.

## correctness

- [Pull request #10](https://github.com/melian-agent/melian/pull/10) ([record](../comparisons/2026-10-03-pr-10.md)): 2, the pinned-deps script crashes on a stray file; 5, the workspace build runs packages in no dependency order.
- [Pull request #11](https://github.com/melian-agent/melian/pull/11) ([record](../comparisons/2026-10-03-pr-11.md)): 8, paths use the platform separator but are compared with forward slashes.
- [Pull request #12](https://github.com/melian-agent/melian/pull/12) ([record](../comparisons/2026-10-03-pr-12.md)): 1, `diff.renameLimit` is not pinned; 4, a `__proto__` key replaces a merged object's prototype; 5, `diff.orderFile` is not pinned; 6, a missing root leaks a raw `ENOENT`; 7, `gitOutput` names `-c` in its error; 21, any git failure maps to one code and drops stderr; 22, a negated ref resolves; 25, `@` imports and `~~~` fences are misread; 27, a path that is not UTF-8 comes back as one git cannot find.
- [Pull request #13](https://github.com/melian-agent/melian/pull/13) ([record](../comparisons/2026-10-03-pr-13.md)): 1, two findings on identical code share an ID; 6, location alone calls an old defect `affected`; 11, a formatter's rewrap changes an ID; 12, paths are never canonicalised; 14, `readFindings` aliases the cached document; 18, a region may end before it starts; 19, a finding in an added binary file is not `introduced`; 20, a file deleted at head is classified; 21, NUL-joined hash fields collide; 22, a nested `undefined` fails as a `TypeError`.
- [Pull request #15](https://github.com/melian-agent/melian/pull/15) ([record](../comparisons/2026-10-03-pr-15.md)): A5, an OAuth token inside the refresh window is selected; A6, a tier's fallbacks are discarded; B4, a disabled lens leaves stale findings; B7, `report_finding` stores `block` for a pre-existing P1; B8, lines past a 256 KiB cut can be neither read nor reported; B9, a search under a missing path returns no matches; B11, the change prompt prints its `@@` range twice; B13, `nearer` misses a folder nothing changed beneath; B16, precision counts duplicates as true positives.
- [Pull request #16](https://github.com/melian-agent/melian/pull/16) ([record](../comparisons/2026-10-03-pr-16.md)): A1, a stored static sighting never reaches the verdict; A2, a check with no record leaves no trace; A4, a merge lets an unevidenced P0 swallow an evidenced P1; B1, a retarget attaches to the old lens run; B3, dedupe ignores lifecycle; B10, `allowSkip` cannot be reached.
- [Pull request #18](https://github.com/melian-agent/melian/pull/18) ([record](../comparisons/2026-10-03-pr-18.md)): A2, a rename makes every base result introduced; A9, a `!` glob in `require` always counts as missing; A10, patterns miss CRLF lines; A11, braces in globs match nothing; A12, a check named `constructor` throws; A13, five thousand nested groups throw `RangeError`; A15, YAML objects keep prototypes; A16, a large class takes hundreds of milliseconds a line; A17, same-named required-files rules collapse; A18, `\01` reads as NUL; C1, workspace siblings resolve to the checkout's sources; C5, dropped tsc diagnostics count as a crash; C13, `compileGlob` throws a non-`Error`; C15, a second error on a flagged line is hidden; C17, gitignore-style globs never match; C18, `(?i)` is misreported; C20, `identify` reads every source error as absence; C22, every run prunes the user's own worktrees.
- [Pull request #19](https://github.com/melian-agent/melian/pull/19) ([record](../comparisons/2026-10-03-pr-19.md)): B2, every marker read repeats the refused `/user` request.
- [Pull request #34](https://github.com/melian-agent/melian/pull/34) ([record](../comparisons/2026-10-04-pr-34.md)): A1, a `cause` location on an unrelated changed line makes an old defect block, expected advisory once the verifier lands; B1, the comment says "deleted by this change" for lines the change never touched; C1 and C2, two lenses sighting one defect must keep both claims; E1 and E2, a directory move must leave a finding in a moved file `pre-existing`; E3, a merge must keep the location that proves its cause.
- [Pull request #36](https://github.com/melian-agent/melian/pull/36) ([record](../comparisons/2026-10-04-pr-36.md)): C1 to C4, the two goldens [the fifth live run](../runs/2026-10-04-live-goldens-5.md) proposes for the declared-input rule: a documented contract the base already holds, and an input only a parameter's type allows, expected to draw nothing.
- [Pull request #48](https://github.com/melian-agent/melian/pull/48) ([record](../comparisons/2026-10-05-pr-48.md)): C1, a root that maps `P2` to `silent` passes an edit to itself, because its policy notice resolves under the root's own configuration rather than the one that judged it; D1, a negative golden: a change that keys a resolution floor on the `ruleId` of a deduplicated finding, where the rule's findings carry no snippet and so never merge, expected to draw nothing.

## contracts

- [Pull request #11](https://github.com/melian-agent/melian/pull/11) ([record](../comparisons/2026-10-03-pr-11.md)): 5, the package's public entry exports the fake models.
- [Pull request #13](https://github.com/melian-agent/melian/pull/13) ([record](../comparisons/2026-10-03-pr-13.md)): 3, paths are invalid SARIF URIs; 5, `parseFinding` accepts unknown SARIF members; 9, the SARIF log lacks `tool.driver.rules` and `partialFingerprints`.
- [Pull request #34](https://github.com/melian-agent/melian/pull/34) ([record](../comparisons/2026-10-04-pr-34.md)): A2, a pure rename breaks an unchanged consumer of the old path, expected `affected`.

## Built-in rules

Defects a deterministic rule should catch in every repository, which no lens is meant to:

- An action in `.github/workflows/` pinned to a tag, such as `actions/cache@v4`, rather than a full commit SHA. `trust-boundary` leaves a loose pin to the standards or a static rule, and Melian's own `melian.yaml` carries the forbidden-patterns rule `unpinned-action`, but a repository with neither gets no finding. A built-in rule is owed, with a scripted golden that expects it.

## The pipeline, scripted only

Lens budgets, which a scripted golden can drive and no lens judges:

- [Pull request #37](https://github.com/melian-agent/melian/pull/37) ([record](../comparisons/2026-10-04-pr-37.md)): A4, a lens its budget ends before it reports anything, expected not reviewed; C2, a script that reuses one call ID across rounds under a tight tools budget, expected ended; D1, a lens whose reads are refused past its tools budget, which then reports and finishes, expected ended and not reviewed; D2, a round holding a blocked call, a read, and a search under `budget.tools: 2`, expected both reads to run and no budget end.

## No lens yet

Design challenges and performance, which no lens reviews:

- [Pull request #10](https://github.com/melian-agent/melian/pull/10) ([record](../comparisons/2026-10-03-pr-10.md)): 4, three parallel lists map workspace imports, and a new package must join all three; 9, a branch for the `workspace:` protocol is dead.
- [Pull request #11](https://github.com/melian-agent/melian/pull/11) ([record](../comparisons/2026-10-03-pr-11.md)): 11, the harness wrapper quarantines import paths, not churn.
- [Pull request #13](https://github.com/melian-agent/melian/pull/13) ([record](../comparisons/2026-10-03-pr-13.md)): 16, a finding's ID depends on the model's wording.
- [Pull request #15](https://github.com/melian-agent/melian/pull/15) ([record](../comparisons/2026-10-03-pr-15.md)): B14, loading lenses for two thousand paths takes 22 seconds.
