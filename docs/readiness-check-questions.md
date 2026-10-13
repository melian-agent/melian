# Questions for the milestone 2 readiness check

The [implementation plan](design-implementation-plan.md) says the maintainer runs a readiness check before the rehearsal and the ruleset switch of step 10. These are the open questions gathered while the loop ran. Each names what was seen and what the maintainer decides. Answer one by writing a decision file, or by adding a step to the plan, and strike it here in the same commit.

## The comparison record and `melian compare`

1. **Hand-written records.** On 2026-10-08 the comparison store read zero comparisons clone-wide, so every record under `packages/evals/comparisons/` from `2026-10-03-pr-10.md` through `2026-10-08-pr-101.md`, and the one for pull request 96, was written by hand or exported from a store the clone no longer had. None feeds `melian compare stats` or the retirement line. The retirement criterion counts a missing or pending record as blocking. Decide whether to backfill them, count them as outside the window, or leave the early ones out of the ten most recent eligible pull requests.
2. **A branch changeset exposes only its latest revision.** A round run from a worktree on the branch stores every round as a revision of one changeset, and `melian findings` and `melian compare` reach only the latest. A pull request reviewed that way can be compared at its final head only. No command compares or adjudicates a past revision. Decide whether to add one, or to make the record's form say that earlier rounds are listed by hand.
3. **Detached rounds are separate comparisons.** A round run from a detached worktree is its own changeset keyed by the SHA, so `compare stats` counted [pull request #102](https://github.com/melian-agent/melian/pull/102) as fifteen comparisons and each recurring finding once per round. That inflates recall and precision and breaks the evals guideline's rule that each pull request counts once across rounds. Decide between rounds on the branch, which brings question 2, and grouping range changesets by pull request in `compare stats`.
4. **`--of` refuses a recurring stable ID.** `melian compare adjudicate <range> <id> --verdict duplicate --of <same id>` is refused when the same stable ID recurs in a later round. Adjudication searches every round newest first, so one adjudication is written per round and per ID. Decide whether `--of` should accept an ID from another round of the same pull request.

## Decisions that drifted

5. **Partial supersessions.** The decision index retires a superseded decision whole. Several verifier decisions supersede [2026-10-05-verifier-as-built.md](decisions/2026-10-05-verifier-as-built.md) for one clause each: the report replacement rule, unfinished eval handling, choice 8's fallback condition, choice 10's per-candidate limits, and the terminal-task attachment rule. Others narrow a decision in the same way, such as [2026-10-08-verifier-on-codex-subscription.md](decisions/2026-10-08-verifier-on-codex-subscription.md) on the committed routes. The notes record that no such decision restated the clauses of its target that survive, so the design lens, which reads only active decisions, may no longer see them. This was not audited clause by clause. Decide whether to audit them and add a restating decision for each, or to restate them in one new decision that supersedes the group.

## Lifecycle and trust

6. **Is the recorded-pid supervisor enough on macOS?** A confined process can leave a detached child on macOS. The rule against signalling a process group, or a negative or zero pid, is absolute since a `kill(-1)` took down a user session on 2026-10-08. So the only reaper planned for [pull request #98](https://github.com/melian-agent/melian/pull/98) is a supervisor that walks recorded pids. A child that detaches within one poll interval is never recorded. Decide whether that is enough, or whether a narrowly scoped lifecycle control is worth its risk.

## A small code follow-up

7. **The family notice repeats a primary.** `Plan.familyMessages` in `packages/core/src/plan.ts` builds the condition from the verifier route's first model and the finder's primary. When both are the same model, the notice reads "if openai-codex/gpt-5.6-terra fails and openai-codex/gpt-5.6-terra fails". The list needs de-duplicating. No decision is needed, only the fix and a test that fails without it.
