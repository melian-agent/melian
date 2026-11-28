# What the coordinator may do for the maintainer

Status: ruled by the maintainer on 2026-11-28, in the coordinator's session. The coordinator listed the delegations below, which the maintainer had given one at a time since 2026-10-17, and asked whether to write them into the repository. He answered "yes".

Amends: [When Melian cannot run, the maintainer overrides one commit](2026-10-23-melian-review-outage-procedure.md), who may post the override on a pull request's head: the coordinator too, under the four conditions below
Amends: [An unresolved acknowledgement fails the status, as built](2026-10-17-acknowledge-status-exact-rule.md), what clears a blocking policy notice: the coordinator's override too, under the four conditions below, where it said only a stored dismissal
Amends: [An Actions round sets melian/review, and builders queue](2026-11-07-actions-round-sets-melian-review.md), what a blocking policy notice needs: a fix, a dismissal through a host round, or the coordinator's override under the four conditions below
Amends: [A verifier cannot clear a protected objection without a maintainer](2026-10-17-trust-floor-exact-rule.md), who dismisses a refuted `melian/injection-attempt` finding: the coordinator may, only where every flagged line is Melian's own prompt text and identical to a line already on the default branch

## Problem

The maintainer delegated some of his reads and dismissals to the coordinator, in the coordinator's session. Nothing in the repository said so. A builder cannot check a delegation it cannot read, and all three post under the maintainer's login.

Example: on [pull request #662](https://github.com/melian-agent/melian/pull/662), the round's only finding above advisory was a policy notice on one new learning in AGENTS.md. The coordinator read the change and recorded its read. The builder declined to queue on it, rightly, and the pull request waited for the maintainer to answer "read".

## Choice

The coordinator may do these, and nothing else, in the maintainer's place:

1. **Read a policy notice.** The coordinator may read a `policy-change-review` notice on a file whose change it has read, and record that read on the pull request. A builder may queue on that record as it would on the maintainer's. Two limits keep the coordinator from widening its own authority. It never reads a notice on a pull request it wrote. And on AGENTS.md it may read the notice only when the change adds entries under Learnings and touches no other line of the file; any other change to AGENTS.md, this delegation's own lines included, is the maintainer's to read. The maintainer ruled this on 2026-11-28, in the coordinator's session, after the first round on this decision's own pull request.
2. **Dismiss an equivalent mutant**, with a one-line reason that says why no input can tell the mutant from the code.
3. **Dismiss a finding that restates a ruling**: one whose only objection is to a rule the maintainer has ruled on, when the finding does not block and is not one the trust floor protects. The protected kinds are a finding from `lens.trust-boundary` or `lens.tests`, an `untested-behaviour` finding and a `melian/injection-attempt` finding; whether one of those is only a restatement is the maintainer's to judge. The dismissal names the ruling's date and where it was given. The maintainer ruled this on 2026-11-28, in the coordinator's session, after the first round on this decision's own pull request.
4. **Dismiss a refuted injection flag on Melian's own prompt text that only moved**: a `melian/injection-attempt` finding the verifier refuted, where every flagged line is Melian's own prompt or its instructions for reviewers and is identical to a line already on the default branch. The test is a comparison of text, never the coordinator's judgement of meaning: a flag on any line the change wrote or reworded stays the maintainer's. The maintainer ruled this on 2026-11-28, in the coordinator's session, after the first round on this decision's own pull request.
5. **Post the override status** of [the outage procedure](2026-10-23-melian-review-outage-procedure.md) on a pull request's exact head. This is a new use of that status, not an outage: Melian ran, and the only thing that blocks is a policy notice. It is allowed only when all four hold:
   - a `melian round` workflow run reviewed that head on the committed routes, its comment passes the check in AGENTS.md, and its verdict reads `passed` or `findings` with no check left unrun. A round that reads `not reviewed`, or that lists any check as not run, is never overridden by the coordinator;
   - everything it raised above advisory is a policy notice on a file whose change the coordinator has read, and none of those files is under `.github/workflows/` or is the root `melian.yaml`. A notice on a workflow, which can hold a login, or on the root policy, which decides what blocks, stays the maintainer's;
   - CI is green on that head;
   - the coordinator read the head and the full merge base immediately before posting, and the description ends `; base <40-character merge base>`.

   The outage procedure's own checks before posting still apply: the queue mode, and no other open pull request sharing the head. The coordinator never posts the override on a pull request it wrote. The maintainer ruled this on 2026-11-28, in the coordinator's session, after the first round on this decision's own pull request.

Every such act is posted beginning "Coordinator:", says which of these five it is, and never says the maintainer did it.

Everything else stays the maintainer's. A change to this decision is his to read. An acknowledge finding from a lens needs his read. A blocking finding from a lens needs a fix or his agreement to dismiss. A mutant that is not equivalent, an injection flag on any other text, and a new ruling are his. The override on a merge group's commit stays his.

## Why

- These are the acts where the maintainer's read adds least. A policy notice asks only that a person read a change to a policy file. An equivalent mutant and a restated ruling ask nothing new of him.
- Each came to him often enough to hold pull requests: nine injection flags on Melian's own prompts in about 280 pull requests, and a policy notice on every pull request that adds a learning to AGENTS.md.
- A delegation in the repository can be checked by the builder it affects, and reviewed like any other rule. One held in a session's memory can be neither.

## What it costs

A coordinator's read is weaker than the maintainer's: it is an agent's, posted under his login. The list is short for that reason, and holds nothing that decides whether a lens's finding is real.

## The words of each delegation

- Equivalent mutants and policy notices, 2026-10-17: "yes take the authority and run these".
- Refuted injection flags on Melian's own prompts, 2026-11-20, when parking [pull request #590](https://github.com/melian-agent/melian/pull/590). The coordinator kept no quote of his words that day. On 2026-11-28 he agreed the narrower rule above, identical text only, in place of the coordinator's judgement that the meaning was unchanged.
- The override status, 2026-11-22: "I give you permission to run the override command yourself", then "you may post overrides for these conditions"; and on 2026-11-27, "permission stands".
- Findings that restate a ruling, and the list as a whole, 2026-11-28: "yes".

All were given in the coordinator's session.
