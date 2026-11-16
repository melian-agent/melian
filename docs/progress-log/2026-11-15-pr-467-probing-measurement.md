# Pull request #467: the probing measurement on the live harness

Builder agent: [pull request #467](https://github.com/melian-agent/melian/pull/467) builds [issue #356](https://github.com/melian-agent/melian/issues/356). The probing level's routes are measured on `live.ts`'s harness, over the probing goldens and the trust-boundary lens's recorded misses.

## Rulings and answers

- The live run is the coordinator's, by the maintainer's ruling of 2026-11-09.
- Hand mutant proof is owed only for changed code that guards trust or durability, by the maintainer's ruling of 2026-11-14 in [the narrowing decision](../decisions/2026-11-14-hand-mutation-proof-only-for-trust-and-durability.md). Mutants lists which pass claimed which files.
- The final rerun of earlier claims at the last head is waived for good, by [the decision of 2026-11-10](../decisions/2026-11-10-final-rerun-waived-until-mutants-verify.md) and [the decision of 2026-11-14](../decisions/2026-11-14-mutants-verify-is-not-built.md) that gave the waiver no end date. Each pass proves its own commits' mutants, and that is this pull request's proof.
- Pair 1 runs first: the goldens at 3 passes, then the misses at 1 pass. The maintainer ruled this on 2026-11-15, in the coordinator's session.
- Only a hand-entered `lines` range scores a miss, found or missed. A location derived from a fix decides nothing: the miss is unadjudicated whenever an unrefuted sighting sits at its file under its rule, and missed only when none does. The maintainer chose this, option A of three the coordinator put, on 2026-11-16, in the coordinator's session.
- The coordinator answered approach questions, which are not rulings:
  - A miss scores on the trust-boundary lens's own sightings.
  - A hit located by a fix with more than one hunk in the miss's file is left unadjudicated, and gets no score. The ruling of 2026-11-16 widened this to every fix.
  - A miss's probes run only when the invocation vouches for both its base and its head, since the base supplies the policy.
  - Claims pair with sightings by core's full claim identity: ID, check and level.
  - Each hit carries what its claim already holds, and nothing more is persisted.

## What it measures

`npm run eval:probing -w @melian-agent/evals` runs `src/probing-live.ts`. Each combination reviews every probing golden and every miss on its own route. The results file holds every review, and the run replaces it whole after each pass, so a cut run keeps the passes it finished. It records the checkout's commit and the commits each miss's names resolve to.

A miss counts as found only when three things hold. A trust-boundary sighting sits at the miss's file under its rule, the verdict leaves the claim of that sighting's ID and level unrefuted, and the sighting overlaps the lines the misses file names. A fix's hunks, the old side of its diff against the head the review froze, only show the reader where to look.

The score follows the verdict. An unrefuted claim counts whether or not its probe was sound. The results file lets a reader check: each hit and near entry carries its claim's `evidence` and `verification`, the verifier's verdict and reason among them. A stored claim names no probe, so the file cannot say which probe a hit rests on; the telemetry keeps each probe's attack and how it ended. The full rendered review is kept by running with `MELIAN_EVAL_SHOW=1` and keeping the terminal output beside the results file.

- **Sightings, level by level.** `readFindings` with `producers: [{ check: "lens.trust-boundary", version }]` and `asReported: true` returns one level's own sightings. The pipeline already exported it, so this pull request exports nothing new from the pipeline. A first read across the levels names which levels sighted anything, and one read per level follows. One read across levels would not do: an ID excludes lines, so quick and careful can sight one ID at different lines, and that read keeps the most severe level's lines. A sighting counts only when the verdict holds the claim of its ID and level unrefuted. A sighting with no claim, a claim with no sighting, or a claim held twice gives the miss no score and names the ID and level. Each entry carries the sighting's own lines and words, with `sightedBy` naming whose they are.
- **Golden scoring is unchanged.** A golden's run returns no sightings. The branch's first commit, `7671487a`, added 23 lines to `packages/evals/test/goldens.test.ts`, and no commit since has touched the file; it passes unchanged. The runRange test "returns trust-boundary's own sightings at the head beside the verdict, and a golden's run returns none" shows the same at the runner.
- **No score from a fix.** A fix's diff says which lines changed, not which defect each held. One hunk can repair two touching defects, and several hunks can repair more than the miss. So a miss located by its fix matches as `fix hunks`, however many hunks the fix has. When a sighting sits at the file under the rule, it prints "unadjudicated, no score" with every hunk and the ones the sightings overlap. A miss with neither lines nor a fix is unadjudicated the same way. An unadjudicated miss may hold another defect's sighting, so its review gets no score and its pass no miss recall. A review that sighted nothing at the file under the rule still scores as missed.

## Codex's adversarial reviews

| Review | Head | Findings | Fix |
| --- | --- | --- | --- |
| 356a | `91d5423b` | medium: the results omit what was measured; medium: the file is written only at the end | `7edaf148` |
| 356b | `6e57c8e0` | high: misses probe only at the literal `deep` level; medium: matching ignores merged claims | `1ab7c066`, `073bf383` |
| 356c | `2f47e2af` | medium: telemetry counts a probed attack as skipped; medium: no mutation inventory for the trust decision | `5d1cb395`; this entry's inventory |
| 356d | `5d1cb395` | high: a miss matches on file and broad rule alone | `8fe10c2b` |
| 356e | `8fe10c2b` | high: matching reads the merged speaker, not the trust-boundary claim | `0fd57c22` |
| 356f | `e159d6e0` | medium: a miss's lines resolve from its head ref, not the reviewed commit | `82391f55` |
| 356g | `82391f55` | high: head-only trust lets an unvouched base's `probe.read` reach a probe; medium: unadjudicated hits raise miss recall | `e9cb18e3` |
| 356h | `026482a0` | high: the results keep no evidence to check a probe-backed hit; medium: claims pair with sightings by ID alone | `95b3515d` |

The Actions round 43706675113 at `8fe10c2b` raised:

- a hand-joined range string, fixed in `bb2e8f78`;
- a score resting on the union of a fix's hunks, fixed in `b2c9b3f2`;
- untested routing per combination, fixed in `37fa8a66`.

Its policy notice on `packages/evals/package.json` is the coordinator's to read. The one change is the `eval:probing` script.

The Actions round 43710063296 at `e9cb18e3` raised the same notice, and one P2. `execFileSync` forwarded git's "cannot change to" diagnostic, which quotes a misses file's repository path, to the terminal raw. `06106398` pipes every stream.

The Actions round 43711601290 at `dcf75544` raised the same notice and three P2s:

- `correctness` and `design` found one defect. A miss whose every `trust-boundary` claim the verifier refuted threw "which the verdict holds no claim for" and got no score, since the match read only the verdict's findings and refuted claims sit in their own group. `601a9e1d` matches against `Verdict.all()`, core's existing query over every group, and fixes its TSDoc to name the refuted group. A refuted claim then scores the miss as not found. A dismissed claim counts by its own verification: the measurement asks whether the lens sighted the defect and the verifier let it stand, and a dismissal is a person's later call that a fresh store cannot hold. A test and [the evals guideline](../guidelines/evals.md#measuring-the-probing-levels-routes) pin that choice. Golden precision still scores the findings alone. The coordinator chose this fix.
- `tests` found that no test held a false positive, so a pass's precision forced to 1 survived. `6d3ffaa0` puts one on the clean golden in the first pass.

## The review of record at `dcf75544`

Opus 5.5 reviewed `c05b435d...dcf75544` with a fresh context. Its gate passed, 9,680 tests, and 16 trust mutants it ran by hand each failed their test. It raised:

- R1, P2: the mutation inventory was not yet in the diff. This entry's inventory answers it.
- R2, P3: one fix hunk that repairs two touching defects credits the other defect's sighting as found. It is the fourth instance of the class "how a miss is located and matched", after the hunks union, the head ref read again, and the refuted-only miss. The coordinator took the class to the maintainer, who ruled on 2026-11-16 as Rulings above records. `0108e526` follows the ruling.
- R3, P3: a misses entry with a typo in its file, rule or lines scored a clean miss, and the run exited 0. `222bf092` refuses such an entry, exit 2, before any provider: its file must be one the range changes, its rule one the base's `trust-boundary` lens declares for the file's folder, and its lines inside the file at the head. `055d08de` adds the tests its mutants were owed: a range that changes two files, and a nested lens that declares the miss's rule.

The fixes for the round, R3 and R2 landed together after the ruling, so the delta review of record runs once.

## The delta review of record at `31c545c6`

Opus 5.5 reviewed `dcf75544...31c545c6` with a fresh context. It raised:

- R1: a misses entry whose file the base's `trust-boundary` lens never reviews still scored. A `paths` setting that leaves the file out passed every refusal, and the miss scored as missed. It is the second instance of the class "an entry the review cannot score that still scores", after R3 at `dcf75544`. The coordinator answered on approach: close the class with two checks that each ask an authority. `34aad52c` adds both.
  - Before any provider, the entry is refused, exit 2, when `Lens.select` under the base's loaded configuration leaves its file out of `trust-boundary`'s files, which covers a `paths` exclusion and a disabled lens alike, or when its file is empty or absent at the head.
  - After the review, a miss scores only when the review's own record shows the lens looked: a completed `trust-boundary` stage in the review's telemetry, other than the prober's, whose `coverage` holds the file by core's `lensCovers`. Each lens stage now carries the coverage its conversation's stored `LensPolicy` holds in `LensDocument`. A review with no such stage prints the miss as unadjudicated, with no score, and says why.
- R2: the description listed `goldens.ts` among pass 6's claimed files, and pass 6 claimed none of it. Mutants below now says which pass claimed which files, and pass 6's claims on `reviewTarget`'s guards were run by hand.
- R3: the description did not cite the waiver of the final rerun. Rulings above cites it.

## The delta review of record at `b88e57d0`

Opus 5.5 reviewed `31c545c6...b88e57d0` with a fresh context and would not block. Its gate passed, 9,687 tests, and every mutant its samples of passes 6 and 17 selected behaved as claimed. It raised two P3s. The coordinator answered both on approach:

- R1: a miss on a file the head renamed was refused, though the review covers a renamed file through its old path. `eddc1917` reads the file's old path from the changeset, and accepts the miss when `Lens.select`'s files hold either path, as the review does.
- R2: the scope check reads where the lens's stored policy let it look, not what it was shown. A lens's prompt is cut past 200 KB of diff, the review keeps no record of the cut, and a miss whose file the cut left out still scores as missed. That is a third instance of the class "an entry the review cannot score that still scores". `d512c521` narrows [the evals guideline](../guidelines/evals.md#measuring-the-probing-levels-routes) to say so, and to read such a "missed" as not adjudicated. Recording what each lens was shown and read is a new stored record, so it is [issue #485](https://github.com/melian-agent/melian/issues/485), done before the misses run. The goldens are not affected: the largest golden's whole head is about 41 KB.

Codex's review at `b88e57d0` raised one medium: `Verdict.all()` lists refuted findings, so `recordDismissal` accepts a refuted finding's ID. `main` already lists them there, and this pull request changed only that method's TSDoc, so the finding is `main`'s, and [issue #486](https://github.com/melian-agent/melian/issues/486) asks the maintainer whether a refuted finding's ID may be dismissed.

## Failing tests first

Each fix began with a test that failed at the head before it:

- 356a: 3 failed of 30, among them "records what it measured" and "replaces the results file whole after each pass".
- 356b: 2 failed of 32, the merged-claim test and "probes a miss at whichever level its review picks, when its base policy sets no floor".
- 356c: 1 failed of 109 in the pipeline's stage telemetry test.
- 356d: 7 failed of 34 once misses carried lines.
- 356e: 6 failed of 36, among them "gives a miss no score when the verdict and the lens's sightings disagree on which claims it made".
- The hunks fix: 2 failed of 36.
- 356f: 1 failed of 37. The ref moved after the target froze, and `locate` returned `[[1,5],[8,8]]` where the reviewed commit's fix changed `[[3,3]]`.
- 356g: 3 failed of 37 on trust, then 1 more once trust passed: a run whose only hit was unadjudicated exited 0 with a miss recall.
- 356h: 2 failed of 39. Quick's refuted sighting at the miss's lines scored as a hit on careful's upheld claim five lines below. The read returned only quick's merged sighting, where each level's was expected.
- The terminal escape: 1 failed of 40. A child process's stderr held `fatal: cannot change to` and the escaped path.
- The refuted-only miss: 1 failed of 42, with `m: lens.trust-boundary sighted 215518d04356c417 at b878e8bcfd1e@deep, which the verdict holds no claim for`.
- The false positive: the new test passed on the code and failed with the round's mutant, precision forced to 1 at `probing.ts:770`: `expected [ 1, 1, 1 ] to deeply equal [ 0.5, 1, 1 ]`.
- R3: 1 failed of 43, the misses file exiting 0 where 2 was expected.
- R2: 3 failed of 44 against the code before `0108e526`. A fix of one hunk at the defect matched as `lines`, so its sighting scored as found where the ruling leaves it unadjudicated.

- R1 at `31c545c6`: 3 failed of 47. A miss whose only `trust-boundary` stage was cut printed `missed` where `unadjudicated, no score` was expected. The refusal test, with entries on a file the base's `paths` leaves out, under a disabled lens, on an empty file and on a gone file, read status 0 and no errors where 2 was expected. A lens stage carried no `coverage`.

- R1 at `b88e57d0`: 1 failed of 48. A miss on `moved/claim.yml`, renamed from a path the base's lens covers, read status 2 with "the base's policy does not let the trust-boundary lens review moved/claim.yml", where 0 was expected.

After each fix, every probing test passed: 40 of 40 at `06106398`, 40 of 40 at `dcf75544`, 45 of 45 at `055d08de`, 47 of 47 at `34aad52c`, and 48 of 48 at `eddc1917`.

## Mutants

`2026-11-15-pr-467-mutants.json` holds the inventory, one pass per range, each from `node scripts/enumerate-mutants.mjs <range> --json --limit 10000` with nothing omitted. Each pass claims every mutant in the files its `claimsIn` names, and no pass claims more than was run:

| Pass | Claimed files |
| --- | --- |
| 6 | `probing.ts`, `probing-live.ts`, and 13 rows of `goldens.ts` |
| 7 | `probing.ts` |
| 13 | `probing.ts`, `goldens.ts` |
| 16 | `probing.ts` |
| 17 | `probing.ts`, `telemetry.ts` |
| 18 | `probing.ts` |

Every claim was run by hand: a scratch script applied the mutant and ran its named test alone, and a kill counted only when exactly one test ran and failed.

- Pass 6, `c05b435d...5d1cb395`: 471 killed, 4 equivalent. One kill was run in a clean worktree with the mutant committed, since its test reads the checkout's status. 12 kills and 1 equivalence are `goldens.ts` rows, claimed by hand at `5d1cb395` for the delta review's R2: `reviewTarget`'s throw on a review in error, and its throw on a level that ran without probes. Those rows carry their own note, and `goldens.ts` stays out of the pass's `claimsIn`, since its other rows stay unclaimed. The enumerator plants no mutant on the writer handed to the review, so three hand mutants replaced it with a trusted writer, an untrusted one and none; each failed its test, and the pass's `handMutants` records them.
- Pass 7, `5d1cb395...8fe10c2b`: 87 killed, 1 equivalent. Its two survivors at `8fe10c2b` were rerun at `dcf75544` in pass 13 and killed there.
- Pass 13, `8fe10c2b...dcf75544`: 139 killed, 5 equivalent, 2 owed a test. Both sat in the "hits overlap" message. The R2 fix rewrote it, removing the optional chain, and its test kills the rewritten line's mutants in pass 16.
- Pass 16, `f8c3da9e...055d08de`: 76 killed, covering the round's fix, R3 and R2. R3's three survivors at `87f01fae` are among them: two killed by the test `055d08de` adds, and an optional chain removed.
- Pass 17, `31c545c6...34aad52c`: 73 killed, 3 equivalent, 1 owed a test. The test `e3de7fa1` adds, a `trust-boundary` stage with no coverage, kills it. `telemetry.ts` is claimed because the score's second check reads the coverage it records.
- Pass 18, `b88e57d0...eddc1917`: 17 killed, 1 equivalent, 1 owed a test. The survivor accepted any rename, whether or not the base's lens covered its old path. `8567bb73` adds a base that leaves the old path out, with a head that also changes a file the lens covers, so the lens is selected and only the old-path check decides; the mutant fails it, run alone. The same commit renamed the test, so the two kills that named it were rerun under its new name at `8567bb73`, and failed again.

Each equivalence carries its reason in the inventory. Rows outside the claimed files carry a note citing the ruling of 2026-11-14, and ignored rows keep the enumerator's configuration note.
