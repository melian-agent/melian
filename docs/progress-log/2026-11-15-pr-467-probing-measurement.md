# Pull request #467: the probing measurement on the live harness

Builder agent: [pull request #467](https://github.com/melian-agent/melian/pull/467) builds [issue #356](https://github.com/melian-agent/melian/issues/356). The probing level's routes are measured on `live.ts`'s harness, over the probing goldens and the trust-boundary lens's recorded misses.

## Rulings and answers

- The live run is the coordinator's, by the maintainer's ruling of 2026-11-09.
- Hand mutant proof is owed only for changed code that guards trust or durability, by the maintainer's ruling of 2026-11-14. This pass claims mutants in `probing.ts`, `probing-live.ts` and `goldens.ts`.
- Pair 1 runs first: the goldens at 3 passes, then the misses at 1 pass. The maintainer ruled this on 2026-11-15, in the coordinator's session.
- The coordinator answered approach questions, which are not rulings:
  - A miss scores on the trust-boundary lens's own sightings.
  - A hit located by a fix with more than one hunk in the miss's file is left unadjudicated, and gets no score.
  - A miss's probes run only when the invocation vouches for both its base and its head, since the base supplies the policy.
  - Claims pair with sightings by core's full claim identity: ID, check and level.
  - Each hit carries what its claim already holds, and nothing more is persisted.

## What it measures

`npm run eval:probing -w @melian-agent/evals` runs `src/probing-live.ts`. Each combination reviews every probing golden and every miss on its own route. The results file holds every review, and the run replaces it whole after each pass, so a cut run keeps the passes it finished. It records the checkout's commit and the commits each miss's names resolve to.

A miss counts as found only when three things hold. A trust-boundary sighting sits at the miss's file under its rule, the verdict leaves the claim of that sighting's ID and level unrefuted, and the sighting overlaps the defect's lines. The lines come from the miss itself, or from the old side of its fix's hunks against the head the review froze.

The score follows the verdict. An unrefuted claim counts whether or not its probe was sound. The results file lets a reader check: each hit and near entry carries its claim's `evidence` and `verification`, the verifier's verdict and reason among them. A stored claim names no probe, so the file cannot say which probe a hit rests on; the telemetry keeps each probe's attack and how it ended. The full rendered review is kept by running with `MELIAN_EVAL_SHOW=1` and keeping the terminal output beside the results file.

- **Sightings, level by level.** `readFindings` with `producers: [{ check: "lens.trust-boundary", version }]` and `asReported: true` returns one level's own sightings. The pipeline already exported it, so this pull request exports nothing new from the pipeline. A first read across the levels names which levels sighted anything, and one read per level follows. One read across levels would not do: an ID excludes lines, so quick and careful can sight one ID at different lines, and that read keeps the most severe level's lines. A sighting counts only when the verdict holds the claim of its ID and level unrefuted. A sighting with no claim, a claim with no sighting, or a claim held twice gives the miss no score and names the ID and level. Each entry carries the sighting's own lines and words, with `sightedBy` naming whose they are.
- **Golden scoring is unchanged.** A golden's run returns no sightings. The branch's first commit, `7671487a`, added 23 lines to `packages/evals/test/goldens.test.ts`, and no commit since has touched the file; it passes unchanged. The runRange test "returns trust-boundary's own sightings at the head beside the verdict, and a golden's run returns none" shows the same at the runner.
- **No score on a union of hunks.** A fix that changes one hunk in the miss's file locates the miss there, and a hit is `found`. A fix with several hunks locates the miss on all of them, so a hit is recorded as `fix hunks`. It prints "unadjudicated, no score" with every hunk and the ones the hits overlap. A file-and-rule hit is unadjudicated the same way. An unadjudicated hit may be another defect's, so its review gets no score and its pass no miss recall. A review that found nothing at the file under the rule still scores as missed.

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

- `correctness` and `design` found one defect. A miss whose every `trust-boundary` claim the verifier refuted threw "which the verdict holds no claim for" and got no score, since the match read only the verdict's findings and refuted claims sit in their own group. The held fix matches against `Verdict.all()`, core's existing query over every group, and fixes its TSDoc to name the refuted group. A refuted claim then scores the miss as not found. A dismissed claim counts by its own verification: the measurement asks whether the lens sighted the defect and the verifier let it stand, and a dismissal is a person's later call that a fresh store cannot hold. A test and [the evals guideline](../guidelines/evals.md#measuring-the-probing-levels-routes) pin that choice. Golden precision still scores the findings alone. The coordinator chose this fix.
- `tests` found that no test held a false positive, so a pass's precision forced to 1 survived. A held test puts one on the clean golden in the first pass.

## The review of record at `dcf75544`

Opus 5.5 reviewed `c05b435d...dcf75544` with a fresh context. Its gate passed, 9,680 tests, and 16 trust mutants it ran by hand each failed their test. It raised:

- R1, P2: the mutation inventory was not yet in the diff. This entry's inventory answers it.
- R2, P3: one fix hunk that repairs two touching defects credits the other defect's sighting as found. It is the fourth instance of the class "how a miss is located and matched", after the hunks union, the head ref read again, and the refuted-only miss. The coordinator took the class to the maintainer, and its fix waits on that ruling.
- R3, P3: a misses entry with a typo in its file, rule or lines scored a clean miss, and the run exited 0. The fix refuses such an entry, exit 2, before any provider: its file must be one the range changes, its rule one the base's `trust-boundary` lens declares, and its lines inside the file at the head.

The fixes for the round, R3 and the class land together once the maintainer rules, so the delta review of record runs once.

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

After each fix, every probing test passed: 40 of 40 at `06106398`, 40 of 40 at `dcf75544`.

## Mutants

`2026-11-15-pr-467-mutants.json` holds the inventory, one pass per range, each from `node scripts/enumerate-mutants.mjs <range> --json --limit 10000` with nothing omitted. Each pass claims the mutants in `probing.ts`, `probing-live.ts` and `goldens.ts`. Every claim was run by hand: a scratch script applied the mutant and ran its named test alone, and a kill counted only when exactly one test ran and failed.

- Pass 6, `c05b435d...5d1cb395`: 459 killed, 3 equivalent. One kill was run in a clean worktree with the mutant committed, since its test reads the checkout's status.
- Pass 7, `5d1cb395...8fe10c2b`: 87 killed, 1 equivalent. Its two survivors at `8fe10c2b` were rerun at `dcf75544` in pass 13 and killed there.
- Pass 13, `8fe10c2b...dcf75544`: 139 killed, 5 equivalent, 2 owed a test. Both sit in the "hits overlap" message, which the fix for R2 rewrites, so their test lands with that fix.

Each equivalence carries its reason in the inventory. Rows outside the claimed files carry a note citing the ruling of 2026-11-14, and ignored rows keep the enumerator's configuration note.
