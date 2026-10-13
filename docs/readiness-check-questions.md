# Questions for the milestone 2 readiness check

The [implementation plan](design-implementation-plan.md) says the maintainer runs a readiness check before the rehearsal and the ruleset switch of step 10. These are the open questions gathered while the loop ran. Each names what was seen and what the maintainer decides. Answer one by writing a decision file, or by adding a step to the plan, and strike it here in the same commit.

## The comparison record and `melian compare`

1. **Hand-written records.** On 2026-10-08 the comparison store read zero comparisons clone-wide, so every record under `packages/evals/comparisons/` from `2026-10-03-pr-10.md` through `2026-10-08-pr-101.md`, and the one for [pull request #96](https://github.com/melian-agent/melian/pull/96), was written by hand or exported from a store the clone no longer had. None feeds `melian compare stats` or the retirement line. The retirement criterion counts a missing or pending record as blocking. Decide whether to backfill them, count them as outside the window, or leave the early ones out of the ten most recent eligible pull requests.
2. **A branch changeset exposes only its latest revision.** A round run from a worktree on the branch stores every round as a revision of one changeset, and `melian findings` and `melian compare` reach only the latest. A pull request reviewed that way can be compared at its final head only. No command compares or adjudicates a past revision. Decide whether to add one, or to make the record's form say that earlier rounds are listed by hand.
3. **Detached rounds are separate comparisons.** A round run from a detached worktree is its own changeset keyed by the SHA, so `compare stats` counted [pull request #102](https://github.com/melian-agent/melian/pull/102) as eighteen comparisons, one per round, and each recurring finding once per round. That overweights one pull request, can move recall and precision either way, and breaks the evals guideline's rule that each pull request counts once across rounds. Decide between rounds on the branch, which brings question 2, and grouping range changesets by pull request in `compare stats`.
4. **`--of` refuses a recurring stable ID.** `melian compare adjudicate <range> <id> --verdict duplicate --of <same id>` is refused when the same stable ID recurs in a later round. Adjudication searches every round newest first, so one adjudication is written per round and per ID. Decide whether `--of` should accept an ID from another round of the same pull request.

## Decisions that drifted

5. **Partial supersessions.** The decision index retires a superseded decision whole. Several decisions narrow [2026-10-05-verifier-as-built.md](decisions/2026-10-05-verifier-as-built.md), each for one clause: [conflicting reports](decisions/2026-10-06-verifier-conflicting-reports.md), [unjudged eval results](decisions/2026-10-06-verifier-eval-unjudged-results.md), [choice 8's fallback condition](decisions/2026-10-06-verifier-explicit-routes.md), [choice 10's per-candidate limits](decisions/2026-10-06-verifier-reading-budget.md), and [the terminal-task attachment rule](decisions/2026-10-06-verifier-undecided-tasks.md). Others narrow a decision the same way, such as [the Codex-subscription decision](decisions/2026-10-08-verifier-on-codex-subscription.md) on the committed routes, which does restate one surviving clause. The design lens reads only active decisions, so any surviving clause a narrowing decision did not restate is invisible to it. An audit clause by clause is owed. Decide whether to run it and add a restating decision for each gap, or to restate the verifier-as-built decision's survivors in one new decision that supersedes the group.

## Lifecycle and trust

6. **Is the recorded-pid supervisor enough on macOS?** A confined process can leave a detached child on macOS. The rule against signalling a process group, or a negative or zero pid, is absolute since a `kill(-1)` took down a user session on 2026-10-08. So the only reaper planned for [pull request #98](https://github.com/melian-agent/melian/pull/98) is a supervisor that walks recorded pids. A child that detaches within one poll interval is never recorded. Decide whether that is enough, or whether a narrowly scoped lifecycle control is worth its risk.

## A small code follow-up

7. **The family notice repeats a primary.** `Plan.familyMessages` in `packages/core/src/plan.ts`, lines 581 to 606, lists in `failures` the verifier route's first model when its family differs from the finder's, and the finder's primary when the finder is a fallback. Both can be the same model when the finder is a fallback of another family and the verifier's first model equals the finder's primary. The notice then reads "if openai-codex/gpt-5.6-terra fails and openai-codex/gpt-5.6-terra fails". The list needs de-duplicating. No decision is needed, only the fix and a test that sets up that route and fails without it.

## Resolution and the status

8. **Should an `acknowledge` finding fail the published status?** No `acknowledge` finding fails `melian/review` today, pre-existing or not. Decide whether one should, repository-wide; step 18 built no gate for `resolution.preExisting`.

## Recurring extra sightings in the design goldens

9. **Two design goldens draw an extra finding in every pass.** `design-identity-missing-input` and `design-terminology-change` each expect one finding. Each reported two in all three passes of the live run at a2793b71, and again in all three at ace07815: six passes of six for both. [The run record](../packages/evals/runs/2026-10-13-live-goldens-authority-rule.md) holds both runs, and [the run of 2026-10-12](../packages/evals/runs/2026-10-12-live-goldens-design-terra.md) shows the same two. An extra that never varies is not a draw. Decide for each whether the second finding is a real defect the golden should declare, a co-report to merge, or noise that owes a negative golden or a change to the lens prompt.

## Policy changes under a parent's switch

10. **A nested file's severities and lens switches change what blocks, unseen.** A nested `melian.yaml` is judged under the directory above it, where a base file may switch `policy-change-review` off. Step 18 made a change to a `resolution` key draw the notice whatever that switch says. A nested file's `guardrails.*.severity` and `lenses.*.enabled` also decide what blocks, and a change to either still stays under the parent's switch. The review of record for [pull request #117](https://github.com/melian-agent/melian/pull/117) noted it. Decide whether those keys force the notice too.
