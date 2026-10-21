# Questions for the milestone 2 readiness check

The [implementation plan](design-implementation-plan.md) says the maintainer runs a readiness check before the rehearsal and the ruleset switch of step 10. These are the open questions gathered while the loop ran. Each names what was seen and what the maintainer decides. Answer one by writing a decision file, or by adding a step to the plan, and strike it here in the same commit.

## The comparison record and `melian compare`

1. ~~**Hand-written records.**~~ Answered by the maintainer on 2026-10-21 in [the readiness rulings](decisions/2026-10-21-readiness-check-rulings.md).
2. **A branch changeset exposes only its latest revision.** A round run from a worktree on the branch stores every round as a revision of one changeset, and `melian findings` and `melian compare` reach only the latest. A pull request reviewed that way can be compared at its final head only. No command compares or adjudicates a past revision. Decide whether to add one, or to make the record's form say that earlier rounds are listed by hand. To be answered by plan step 23, not built: [the compare decision](decisions/2026-10-15-compare-addresses-revisions-by-head.md) keeps a merged pull request's rounds reachable, and its open questions include how a round is addressed. [The rounds decision](decisions/2026-10-18-compare-rounds-exact-rule.md) now proposes the answer, adding a command path to every past round by a stored round ID; it was revised after its attack, before step 23 builds it.
3. ~~**Detached rounds are separate comparisons.**~~ Answered by the maintainer on 2026-10-21 in [the readiness rulings](decisions/2026-10-21-readiness-check-rulings.md).
4. ~~**`--of` refuses a recurring stable ID.**~~ Answered by the maintainer on 2026-10-21 in [the readiness rulings](decisions/2026-10-21-readiness-check-rulings.md).

## Decisions that drifted

5. ~~**Partial supersessions.**~~ Answered by the maintainer on 2026-10-21 in [the readiness rulings](decisions/2026-10-21-readiness-check-rulings.md).

## Lifecycle and trust

6. ~~**Is the recorded-pid supervisor enough on macOS?**~~ Answered by the maintainer on 2026-10-21 in [the readiness rulings](decisions/2026-10-21-readiness-check-rulings.md).

## A small code follow-up

7. ~~**The family notice repeats a primary.**~~ Answered by the maintainer on 2026-10-21 in [the readiness rulings](decisions/2026-10-21-readiness-check-rulings.md).

## Resolution and the status

8. **Should an `acknowledge` finding fail the published status?** No `acknowledge` finding fails `melian/review` today, pre-existing or not. Decide whether one should, repository-wide; step 18 built no gate for `resolution.preExisting`. Answered by the maintainer on 2026-10-16, taking the coordinator's recommendation: yes. An unresolved `acknowledge` finding fails the status, and a maintainer dismisses it with a reason to pass, so a policy notice needs a dismissal on every policy change. [The decision](decisions/2026-10-16-acknowledge-fails-the-status.md) records it; plan step 28 builds it.

## Recurring extra sightings in the design goldens

9. ~~**Two design goldens draw an extra finding in every pass.**~~ Answered by the maintainer on 2026-10-21 in [the readiness rulings](decisions/2026-10-21-readiness-check-rulings.md).

## Policy changes under a parent's switch

10. **A nested file's severities and lens switches change what blocks, unseen.** A nested `melian.yaml` is judged under the directory above it, where a base file may switch `policy-change-review` off. Step 18 made a change to a `resolution` key draw the notice whatever that switch says. A nested file's `guardrails.*.severity` and `lenses.*.enabled` also decide what blocks, and a change to either still stays under the parent's switch. The review of record for [pull request #117](https://github.com/melian-agent/melian/pull/117) noted it. Decide whether those keys force the notice too. Answered by the maintainer on 2026-10-16, taking the coordinator's recommendation: yes, both draw the notice, and so does every other key that decides what blocks. A `resolution` change already did, from step 18. [The decision](decisions/2026-10-16-nested-policy-keys-force-the-notice.md) records it; plan step 30 builds it.

## Fork heads and the mutation check

11. **Does a shared, long-lived review server count as an isolated runner, and who declares it?** Moot: the isolated-runner declaration was removed before it landed, by the ruling on question 13. No host declares itself isolated, and a head from outside the repository's writers runs its tests only in the Actions host's credential-free job.

12. **Should a mutation check that ran a fork's head count toward approval?** Answered by the maintainer on 2026-10-14: it counts, "like CI tests". A clean result from a fork's tests is accepted as a fork's CI test results are. It is forgeable by the head, since the fork's tests write the report Stryker reads, and human review before merge is the control. Survivors it reports still count. [The unconfined decision](decisions/2026-10-14-static-checks-run-unconfined.md) records it.

13. **Must a fork's mutation check run in a job of its own?** Answered by the maintainer on 2026-10-14: yes, "a separate job, no secrets". One job with no credentials and no publishing runs the fork's tests and the mutation check and hands on its result; a second job with credentials runs the lenses and publishes and never executes head code. That design belongs to milestone 3's Actions host. Until it exists, such a head runs no mutation check anywhere, and its pull request reads `not reviewed`. The `--isolated-runner` flag and `MELIAN_ISOLATED_RUNNER` were removed from [pull request #98](https://github.com/melian-agent/melian/pull/98) before it landed. [The unconfined decision](decisions/2026-10-14-static-checks-run-unconfined.md) records the planned shape.

## Answered by the maintainer since the list was written

These were asked while the loop ran, outside this list. Each answer is the maintainer's, quoted where his words survive, with its date. [Pull request #98](https://github.com/melian-agent/melian/pull/98) records them in its decisions and documents.

- **The trust model for forks**, 2026-10-14: "We assume fork code is untrusted, but it only runs within runners it would run on today anyway -- they are themselves isolated. Isolation model is same as current github forks." The README's trust paragraph is rewritten to match on [pull request #98](https://github.com/melian-agent/melian/pull/98).
- **Which tools need a sandbox**, 2026-10-14: "Static analysis tools don't need to run in a sandbox, only agents do." Biome, tsc and Enola run unconfined, as on `main`. [Pull request #112](https://github.com/melian-agent/melian/pull/112), the sandbox boundary, closed unmerged.
- **The mutation check's guard**, 2026-10-14: no sandbox. The check runs a head's tests only when the head is trusted. In the maintainer's words: "as long as when a check is configured, the melian review is not considered fully approved without all static checks that are configured for the repo have been run correctly. So it would mean, fork code run locally -- skipped, but then when run in github PR build, will run -- otherwise we need to not approve that PR." A fork's mutation result counts "like CI tests", and a fork's check runs in a separate job with no secrets once the Actions host exists.
- **The mutation check's timeout**, 2026-10-14: "longer timeout everywhere, we'll make the call later on whether the return is worth it. I want to see how it works in practice with smaller PRs." The default is 7,200 seconds, provisional.

Question 8, whether `acknowledge` should fail the status, was answered on 2026-10-16: it should, from plan step 28. Until that lands, no `acknowledge` finding fails it. A coordinator's belief that it already gated the merge cost [pull request #117](https://github.com/melian-agent/melian/pull/117) rounds before it was corrected.

- **What happens when a provider is out**, 2026-10-16: fail over to Claude for every lens once plan step 27 lands, keep Sol first, and keep an admin bypass on the ruleset only for when both providers are out. A provider limit error now moves a lens, the verifier and every other routed task to the tier's next model; [the decision](decisions/2026-10-16-failover-on-provider-limit.md) records it. Until step 27 lands, Opus scores lower on design and durability, so a round that failed over reads those lenses with that in mind.

## Raised by the review loop's lessons

These follow questions 11 to 13, which [pull request #98](https://github.com/melian-agent/melian/pull/98) added.

14. ~~**How strict is the supersession check?**~~ Answered by the maintainer on 2026-10-21 in [the readiness rulings](decisions/2026-10-21-readiness-check-rulings.md).
15. ~~**When does the review outcome task run?**~~ Answered by the maintainer on 2026-10-21 in [the readiness rulings](decisions/2026-10-21-readiness-check-rulings.md).
16. **Does the mutation check's final run reuse the cache?** [The rerun decision](decisions/2026-10-15-mutation-reruns-later-changes-only.md) carries results across heads. Running the last round's mutation check cold is one answer to an open question it lists, because an earlier head can plant `Killed` results and a later head revert the planting code. A cold final run on a branch the size of [pull request #98](https://github.com/melian-agent/melian/pull/98)'s sits near the 7,200-second timeout. Decide whether that cost stands, or whether reuse in the final run is acceptable with a check, such as dropping every cached result whose covering test files differ between the head that wrote it and the final head. From the coordinator: "Only trusted heads run the mutation check, and a writer can forge test results in many ways; the plant-then-revert case is one a human reviewer cannot see in the final diff. Reusing the cache in the final run keeps the speed the maintainer asked for; running it cold closes this case at the cost of one full run per pull request." Answered by the maintainer on 2026-10-16: "Reuse while iterating, final run cold." A run that reuses an earlier head's results is provisional and never lets a review pass; `melian review --cold` runs the check from nothing, and a pull request needs one before the queue. [The as-built decision](decisions/2026-10-16-mutation-reruns-later-changes.md) records it.

17. **May the verifier lower a finding on a trust surface?** On [pull request #125](https://github.com/melian-agent/melian/pull/125) the verifier lowered a real P2 to an advisory, and the review of record found it three rounds later. Answered by the maintainer on 2026-10-16, taking the coordinator's recommendation: the lowering stands, but a lowered `trust-boundary` finding, or an `untested-behaviour` finding that guards approval, stays at `acknowledge` at least. [The decision](decisions/2026-10-16-lowered-trust-finding-stays-acknowledged.md) records it; plan step 29 builds it and settles what "guards approval" reads from.

## One writer per changeset store

18. ~~**Who keeps a changeset’s store to one writer process?**~~ Answered by the maintainer on 2026-10-21 in [the readiness rulings](decisions/2026-10-21-readiness-check-rulings.md).
