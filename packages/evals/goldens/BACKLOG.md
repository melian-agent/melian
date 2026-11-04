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
- [Pull request #62](https://github.com/melian-agent/melian/pull/62) ([record](../comparisons/2026-10-05-pr-62.md)): C4, a model the head's text reaches decides how closely the head is reviewed, here triage choosing `quick` for a pull request with nothing below it, expected `head-controls-judge`.

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
- [Pull request #50](https://github.com/melian-agent/melian/pull/50) ([record](../comparisons/2026-10-05-pr-50.md)): A2, as a negative golden, a change that leaves an optional member `undefined` in a task's input or result, expected to draw nothing.

## correctness

- [Pull request #10](https://github.com/melian-agent/melian/pull/10) ([record](../comparisons/2026-10-03-pr-10.md)): 2, the pinned-deps script crashes on a stray file; 5, the workspace build runs packages in no dependency order.
- [Pull request #12](https://github.com/melian-agent/melian/pull/12) ([record](../comparisons/2026-10-03-pr-12.md)): 1, `diff.renameLimit` is not pinned; 4, a `__proto__` key replaces a merged object's prototype; 5, `diff.orderFile` is not pinned; 6, a missing root leaks a raw `ENOENT`; 7, `gitOutput` names `-c` in its error; 21, any git failure maps to one code and drops stderr; 22, a negated ref resolves; 25, `@` imports and `~~~` fences are misread; 27, a path that is not UTF-8 comes back as one git cannot find.
- [Pull request #13](https://github.com/melian-agent/melian/pull/13) ([record](../comparisons/2026-10-03-pr-13.md)): 1, two findings on identical code share an ID; 6, location alone calls an old defect `affected`; 11, a formatter's rewrap changes an ID; 12, paths are never canonicalised; 14, `readFindings` aliases the cached document; 18, a region may end before it starts; 19, a finding in an added binary file is not `introduced`; 20, a file deleted at head is classified; 21, NUL-joined hash fields collide; 22, a nested `undefined` fails as a `TypeError`.
- [Pull request #15](https://github.com/melian-agent/melian/pull/15) ([record](../comparisons/2026-10-03-pr-15.md)): A5, an OAuth token inside the refresh window is selected; A6, a tier's fallbacks are discarded; B4, a disabled lens leaves stale findings; B7, `report_finding` stores `block` for a pre-existing P1; B8, lines past a 256 KiB cut can be neither read nor reported; B9, a search under a missing path returns no matches; B11, the change prompt prints its `@@` range twice; B13, `nearer` misses a folder nothing changed beneath; B16, precision counts duplicates as true positives.
- [Pull request #16](https://github.com/melian-agent/melian/pull/16) ([record](../comparisons/2026-10-03-pr-16.md)): A1, a stored static sighting never reaches the verdict; A2, a check with no record leaves no trace; A4, a merge lets an unevidenced P0 swallow an evidenced P1; B1, a retarget attaches to the old lens run; B3, dedupe ignores lifecycle; B10, `allowSkip` cannot be reached.
- [Pull request #18](https://github.com/melian-agent/melian/pull/18) ([record](../comparisons/2026-10-03-pr-18.md)): A2, a rename makes every base result introduced; A9, a `!` glob in `require` always counts as missing; A10, patterns miss CRLF lines; A11, braces in globs match nothing; A12, a check named `constructor` throws; A13, five thousand nested groups throw `RangeError`; A15, YAML objects keep prototypes; A16, a large class takes hundreds of milliseconds a line; A17, same-named required-files rules collapse; A18, `\01` reads as NUL; C1, workspace siblings resolve to the checkout's sources; C5, dropped tsc diagnostics count as a crash; C13, `compileGlob` throws a non-`Error`; C15, a second error on a flagged line is hidden; C17, gitignore-style globs never match; C18, `(?i)` is misreported; C20, `identify` reads every source error as absence; C22, every run prunes the user's own worktrees.
- [Pull request #19](https://github.com/melian-agent/melian/pull/19) ([record](../comparisons/2026-10-03-pr-19.md)): B2, every marker read repeats the refused `/user` request.
- [Pull request #34](https://github.com/melian-agent/melian/pull/34) ([record](../comparisons/2026-10-04-pr-34.md)): A1, a `cause` location on an unrelated changed line makes an old defect block, expected advisory once the verifier lands; B1, the comment says "deleted by this change" for lines the change never touched; C1 and C2, two lenses sighting one defect must keep both claims; E1 and E2, a directory move must leave a finding in a moved file `pre-existing`; E3, a merge must keep the location that proves its cause.
- [Pull request #36](https://github.com/melian-agent/melian/pull/36) ([record](../comparisons/2026-10-04-pr-36.md)): C1 to C4, the two goldens [the fifth live run](../runs/2026-10-04-live-goldens-5.md) proposes for the declared-input rule: a documented contract the base already holds, and an input only a parameter's type allows, expected to draw nothing.
- [Pull request #48](https://github.com/melian-agent/melian/pull/48) ([record](../comparisons/2026-10-05-pr-48.md)): C1, a root that maps `P2` to `silent` passes an edit to itself, because its policy notice resolves under the root's own configuration rather than the one that judged it; D1, a negative golden: a change that keys a resolution floor on the `ruleId` of a deduplicated finding, where the rule's findings carry no snippet and so never merge, expected to draw nothing.
- [Pull request #62](https://github.com/melian-agent/melian/pull/62) ([record](../comparisons/2026-10-05-pr-62.md)): A2, a clamp that returns a value outside its bounds when no candidate lies inside them, expected `wrong-result`; C1, a value chosen from a declared set reaches a lookup that throws for some members, here a level whose tier has no route, expected `unhandled-error`.

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

## design

The design corpus now has twenty-four goldens. Nine of its ten design rules have coverage, including the terminology-change case for criterion-selection-bias. Source-based positives and clean twins cover trust-by-label, bound-on-wrong-measure, resumed-identity and single-slot-overwrite. The superseded-at-base clean case and decision-file injection case cover the baseline follow-up. `reimplements-an-authority` has a positive, a positive under an unsupported stated gap, a stated-gap clean case, a no-dependency clean case, and a case under a written standard that `conventions` owns.

- `capability-by-class`: access or an exemption granted to a class whose member should not hold it. [The source decision](../../../docs/decisions/2026-10-07-design-lens-goldens-and-sources.md) points to adversarial review threads but names no finding or record. A source must be identified before this golden is written.

## No lens yet

Design challenges and performance, which no lens reviews:

- [Pull request #10](https://github.com/melian-agent/melian/pull/10) ([record](../comparisons/2026-10-03-pr-10.md)): 4, three parallel lists map workspace imports, and a new package must join all three; 9, a branch for the `workspace:` protocol is dead.
- [Pull request #11](https://github.com/melian-agent/melian/pull/11) ([record](../comparisons/2026-10-03-pr-11.md)): 11, the harness wrapper quarantines import paths, not churn.
- [Pull request #13](https://github.com/melian-agent/melian/pull/13) ([record](../comparisons/2026-10-03-pr-13.md)): 16, a finding's ID depends on the model's wording.
- [Pull request #15](https://github.com/melian-agent/melian/pull/15) ([record](../comparisons/2026-10-03-pr-15.md)): B14, loading lenses for two thousand paths takes 22 seconds.

## Stored comparison backlog

Generated by `melian compare backlog --markdown`. The entries above remain frozen.

- contracts: origin/main...HEAD, d7f13f8033edb8f3, Executable test or other non-production files are treated as unsupported production source, so \`mutants list\` refuses test-only changes (valid).
- trust-boundary: origin/main...HEAD, 17644623b20c1dc0, Scrub repository-local Git variables before trusting the install (valid).
- trust-boundary: origin/main...HEAD, 2e51f34974a7b604, JavaScript enumeration loads Babel config files from scratch's ancestors, executing code outside the isolated parser \(including tracked head code\) (valid).
- trust-boundary: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, 6d6f2402ab51809f, Confirmed \(Codex\): compatibility list table and list JSON print live C1, bidi and separator controls; its error path echoes caller arguments raw and re-emits child stderr (valid).
- trust-boundary: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, 8185c6acf92e7d53, Compatibility list output still emits live terminal controls (valid).
- design: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, 0b27964fa63d183c, 0b27964fa63d183c (noise).

The two local trust-boundary entries are the sightings `LD5` and `LE3` in the local continuation of the [record](../comparisons/2026-10-27-pr-250.md) for [pull request #250](https://github.com/melian-agent/melian/pull/250), and one case covers both: a compatibility-output class golden. The `design` entry is `LF4` in the same record, owing a clean golden for the approved version-2 inventory schema and its deferred policy-currentness claim. All three are owed, not shipped.

The next entries are from rounds 3 and 4 of the same record, sections `LG` to `LK`, on the same base. They owe six cases, one per case below, taken from the adjudications' lens choices. None is shipped, no live eval has run for any, and this change moves no debt count or score.

- contracts: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, c0d5e9aa6a08e379, Binary bun.lockb makes dependency-only Bun updates refuse enumeration (valid).
- contracts: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, 4d01500534dc4795, Bun lockfiles are misclassified as unsupported source (valid).
- correctness: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, a9fabd81c37dad62, Post-worker processing can succeed after the fixed deadline (valid).
- design: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, f10cef73c570f45b, melian/injection-attempt on a coordinator handover the user asked for (noise).
- design: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, 3e1ada1b28f57dc8, bound-on-wrong-measure on awaited reads that the elapsed-budget decision never promised to preempt (noise).
- design: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, e78325a86282abe1, bound-on-wrong-measure on a byte cap read as a fragment-count or parent-RSS bound (noise).
- tests: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, 43200ef31d1a489e, teardown-asymmetry on a suite whose imported helper restores the environment (noise).

- **contracts, `LG3` and `LH1`, one case.** The Bun lockfile classifier. The installation code treats `bun.lockb` as a lockfile, but the data-extension list omits `lockb`, so a range that changes only `package.json` and the binary lockfile is refused as unsupported source. Two reviewers found it by reading the known lockfile authority beside the classifier. Reproduction through the CLI confirms it and does not change that origin, so the reason is `owned-missed`, not `needs-execution`.
- **correctness, `LJ1`.** A late success against the elapsed budget. Work after the worker, such as parsing its output and building the inventory, completes after the fixed deadline and still returns a result. The case expects the listing to be refused, not returned late.
- **tests, `LK10`, clean.** Environment teardown through an imported helper. The suite stubs environment variables and its own teardown does not call `vi.unstubAllEnvs()`, but the helper it imports does, before it removes the repository, and `afterEach` runs that helper. The case expects no finding.
- **design, `LI1`, clean.** Handover provenance. A document the user asked for addresses the next agent in imperative prose. It is provenance data, not a prompt authority at run time. The case expects no `melian/injection-attempt` finding. Round 5 sighted the same handover again as `LN9`, and this one case covers both sightings.
- **design, `LI4`, clean.** Elapsed checks against hard I/O preemption. The approved decision checks an elapsed monotonic budget before and after input and payload and gives the child a remaining timeout. It does not promise to cancel an awaited read. The case expects no `bound-on-wrong-measure` finding.
- **design, `LI6`, clean.** Byte bounds against a fragment or memory assumption. Every fragment is at least one byte, so a byte cap bounds the fragment count, and the decision bounds bytes and child old-space, not the parent's resident memory. The case expects no `bound-on-wrong-measure` finding.

The older owed cases above stay: the compatibility-output class golden for `LD5` and `LE3`, and the clean version-2 inventory schema case for `LF4`.

The last entries are from round 5 of the same record, sections `LL` to `LN`, on the same base. They owe two new cases. `LN9` adds a sighting to the `LI1` case and no case of its own. `LL1` is `needs-execution` and owes no lens golden, and `LN4` is a pre-existing output advisory that owes none. None is shipped, no live eval has run for any, and this change moves no score.

- design: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, fd539ebe7c558f89, melian/injection-attempt on the same coordinator handover, a second sighting of the `LI1` case (noise).
- design: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, 95911b194bcb2632, contradicts-documented-decision on a tracked `node_modules` that the base static-tool trust rule already rejects (noise).
- design: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, 2ec8aaa09f8c5a93, bound-on-wrong-measure on a remaining-aggregate cap that applies before the line-break set-aside (noise).

- **design, `LN12`, clean.** Tracked-installation fallback. The pipeline guideline and base static-tool policy reject an entire tracked `node_modules` as an instrumenter source, as Biome and tsc do, so checkout-first selection holds only while Git does not track it. A tracked file anywhere under it selects Melian's pinned copy and records its source and version in the adapters. The case expects no `contradicts-documented-decision` finding. Relaxing the rule per path would need a new trust ruling.
- **design, `LN13`, clean.** Pre-read aggregate cap. The bounded-protocol decision reads each candidate with the smaller of 16 MiB and the remaining aggregate before allocating, and sets a file aside for incompatible line breaks only after that bounded read. The cap is a refusal bound, not an acceptance guarantee, so the outcome can depend on path order. The case expects no `bound-on-wrong-measure` finding.

The last entries are from the record for [pull request #256](https://github.com/melian-agent/melian/pull/256) ([record](../comparisons/2026-11-04-pr-256.md)): five historical cloud findings on base `319b14d236efb259f79a695b1020144caa0ee2c7` and six local findings on base `dfcf230599de895553ca7e2a8288494ea02dae9f`. They owe eleven cases, one per case below, taken from the adjudications' Golden columns. None is shipped, no live eval has run for any, and this change moves no score. The local `LA5`, `LD3`, `LG2`, `LG3`, `LH2` and `LI1` are valid no-owner P3 findings with golden `none`, and they owe nothing. The other local valid findings, including the query-fake defects `LC4`, `LD2` and `LF1`, the history-scope defect `LG1`, the coverage nit `LG4`, the round 4 nits `LK1` and `LK2`, the matched base-fetch test gap `LK3` and `LM1`, and the round 5 native findings `LN1` (matched with `LP8`), `LN2` (bound in the tools manifest) and `LN3` (matched with `LP6`), also owe none.

- correctness: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, b1bf678a4569bf1e, A bare membership read with nothing to accept fails without a git author (valid).
- correctness: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, c2eb5b511c708184, An unfetchable pull-request base is recorded as every member's own missing commit (valid).
- conventions: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, 5b7847c7980c927d, close() lost its TSDoc, which now sits stacked above refreshMembership (valid).
- trust-boundary: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, 2ea487afb7d97ae1, Post-snapshot JSON export re-serialises the escaped record and emits raw bidi and C1 controls from reviewer text (valid).
- design: 319b14d236efb259f79a695b1020144caa0ee2c7...HEAD, 15743af4e9678ee8, After any membership snapshot, export silently drops the pull request's own comparisons from rounds minted later (valid).
- design: dfcf230599de895553ca7e2a8288494ea02dae9f...HEAD, d70d76986623d127, contradicts-documented-decision on accepting a force-push event whose `afterCommit` is null (noise).
- design: dfcf230599de895553ca7e2a8288494ea02dae9f...HEAD, b2277b38e25a8018, contradicts-documented-decision on treating a publication target for another pull request as exclusive foreign ownership for a range round (noise).
- design: dfcf230599de895553ca7e2a8288494ea02dae9f...HEAD, 063ff1cfd8b3aa92, capability-by-class on one owned or saved member granting every raw comparison in its SQLite store eligibility for the pull-request export (noise).
- design: dfcf230599de895553ca7e2a8288494ea02dae9f...HEAD, 57340f7c29188781, `#N` export without a snapshot reads every store, so an unrelated newer document blocks own-store export (valid).
- design: dfcf230599de895553ca7e2a8288494ea02dae9f...HEAD, 058e29080ed96b49, contradicts-documented-decision on a pull-request export that succeeds with no comparison entries once a snapshot exists (noise).
- correctness: dfcf230599de895553ca7e2a8288494ea02dae9f...HEAD, 3a516c4cb0b264e7, wrong-result on a pull request with exactly one commit, which the fast-forward clause accepts (noise).

- **correctness, historical `A2`.** Author lookup on a read. A bare `melian compare "#N"` with nothing to accept resolves a Git author anyway, so it exits 1 in a clone with no identity. Only acceptance needs an audit author. The case expects a finding on the unconditional lookup.
- **correctness, historical `A4`.** Absent shared base. When the pull request's own base cannot be fetched, classification records it as the missing commit of every member, and refresh can label prior members unreachable. The maintainer kept the missing-commit policy and retained the finding as an advisory. The case expects a finding on the misattribution.
- **conventions, historical `A5`.** Displaced TSDoc. A new method sits between exported `close()` and its doc comment, so `close()` loses its TSDoc and the new method carries two. The case expects a finding for the missing TSDoc on exported package API.
- **trust-boundary, historical `D1`.** Re-serialised escapes. After a membership snapshot, JSON export parses the escaped record and serialises it again, which reverses the safe Unicode escapes on reviewer text and prints raw bidi and C1 controls. The case expects a finding; the fix applies the visible-text escape after the last serialisation.
- **design, historical `G1`.** Cached snapshot against stored ownership. Export keeps only entries whose round is a saved snapshot member, so the pull request's own comparisons from later rounds vanish. Stored ownership is authoritative, and a cached snapshot may predate records. The case expects a finding.
- **design, local `LC10`, clean.** Null-after ban. The exact-round decision names the null-before exception and does not ban a null after endpoint. The core type and a tracked test support both on purpose. The case expects no `contradicts-documented-decision` finding. The missing warning for null after is the separate advisory `LA5`, and a warning rule needs a later ruling.
- **design, local `LF7`, clean.** Foreign publication ownership. The October 27 amendment explicitly amends October 18, makes publication ownership tri-state, and treats a target for another pull request as foreign. That applies to both classification and export, so a range round with such ownership is excluded before the exact-base and association rules. An unowned reopened branch is still ambiguous. The case expects no `contradicts-documented-decision` finding on the foreign-ownership return. Changing it would need a later ruling.
- **design, local `LJ8`, clean.** Store-wide raw eligibility. The October 27 amendments preserve every raw comparison record from an own, member or unreachable-member, or newly owned holding store, keep the raw revision identity, and exclude foreign-only stores. One owned or saved member therefore makes its whole store eligible on purpose. Narrowing eligibility per revision would change that policy and broke two tracked raw-only-addition tests in the native probes. The case expects no `capability-by-class` finding on the store-wide rule. Changing it would need a later ruling.
- **design, local `LH1`.** No-snapshot export scope. With no membership snapshot, `#N` export reads every store's documents, so an unrelated newer document blocks export of the pull request's own store. The October 27 offline-export decision confines compatibility reads without a snapshot to the own pull store, and the CLI guideline refuses only a command that needs the unsupported data. The case expects a finding that the export reads beyond the own store. It is distinct from the history-scope defect `LG1`, which the Melian design lens found and which stays strict for stats and candidate catalogues.
- **design, local `LM7`, clean.** Empty comparisons with a saved snapshot. Source finding `058e29080ed96b49` claimed that a pull-request export with no comparison record should refuse, as it does before the first snapshot. The CLI guideline, the October 18 offline-audit and unreachable-member clauses, and the October 27 stored-history clause make the saved membership, history and audit authorised export data, so empty comparisons do not discard them. The generic export row covers the range and no-snapshot rule and does not ban these exports. An unconditional refusal broke three tracked tests, including the export after `--accept` that shows the audit, and eight native stdout and file exports. The case expects no `contradicts-documented-decision` finding. Changing it would need a later ruling. [The record](../comparisons/2026-11-04-pr-256.md) holds the adjudication.
- **correctness, local `LP7`, clean.** One-commit fast-forward. Source finding `3a516c4cb0b264e7` claimed that the fast-forward check misses a pull request with exactly one commit. The October 18 compare-rounds decision fails closed only when the merge commit's first parent is one of the pull request's commits. In a one-commit fast-forward the commits are the head alone, the first parent is the base, the base is outside that list and is the exact merge base, so the round is a member with the diff GitHub shows. Multi-commit fast-forwards and root merges still refuse. Two inserted stricter-refusal variants reject valid geometries and pass all 19 tracked core tests, which `LN2` records as advisory coverage. The case expects no `wrong-result` finding. Refusing every fast-forward would need a later ruling. [The record](../comparisons/2026-11-04-pr-256.md) holds the adjudication.
