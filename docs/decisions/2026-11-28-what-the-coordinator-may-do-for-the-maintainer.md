# What the coordinator may do for the maintainer

Status: ruled by the maintainer on 2026-11-28, in the coordinator's session. The coordinator listed the delegations below, which the maintainer had given one at a time since 2026-10-17, and asked whether to write them into the repository. He answered "yes".

Amends: [When Melian cannot run, the maintainer overrides one commit](2026-10-23-melian-review-outage-procedure.md), who may post the override on a pull request's head: the coordinator too, under the four conditions below

## Problem

The maintainer delegated some of his reads and dismissals to the coordinator, in the coordinator's session. Nothing in the repository said so. A builder cannot check a delegation it cannot read, and all three post under the maintainer's login.

Example: on [pull request #662](https://github.com/melian-agent/melian/pull/662), the round's only finding above advisory was a policy notice on one new learning in AGENTS.md. The coordinator read the change and recorded its read. The builder declined to queue on it, rightly, and the pull request waited for the maintainer to answer "read".

## Choice

The coordinator may do these, and nothing else, in the maintainer's place:

1. **Read a policy notice.** The coordinator may read a `policy-change-review` notice on a file whose change it has read, and record that read on the pull request. A builder may queue on that record as it would on the maintainer's.
2. **Dismiss an equivalent mutant**, with a one-line reason that says why no input can tell the mutant from the code.
3. **Dismiss a finding that restates a ruling**: one whose only objection is to a rule the maintainer has ruled on. The dismissal names the ruling's date and where it was given.
4. **Dismiss a refuted injection flag on Melian's own prompt text**: a `melian/injection-attempt` finding the verifier refuted, where the flagged text is Melian's own prompt or its instructions for reviewers, and the coordinator has read the diff of that text and its meaning is unchanged.
5. **Post the override status** of [the outage procedure](2026-10-23-melian-review-outage-procedure.md) on a pull request's exact head, only when all four hold:
   - a `melian round` workflow run reviewed that head on the committed routes, finished, and its comment passes the check in AGENTS.md;
   - everything it raised above advisory is a policy notice on a file whose change the coordinator has read;
   - CI is green on that head;
   - the coordinator read the head and the full merge base immediately before posting, and the description ends `; base <40-character merge base>`.

Every such act is posted beginning "Coordinator:", says which of these five it is, and never says the maintainer did it.

Everything else stays the maintainer's. An acknowledge finding from a lens needs his read. A blocking finding from a lens needs a fix or his agreement to dismiss. A mutant that is not equivalent, an injection flag on any other text, and a new ruling are his. The override on a merge group's commit stays his.

## Why

- These are the acts where the maintainer's read adds least. A policy notice asks only that a person read a change to a policy file. An equivalent mutant and a restated ruling ask nothing new of him.
- Each came to him often enough to hold pull requests: nine injection flags on Melian's own prompts in about 280 pull requests, and a policy notice on every pull request that adds a learning to AGENTS.md.
- A delegation in the repository can be checked by the builder it affects, and reviewed like any other rule. One held in a session's memory can be neither.

## What it costs

A coordinator's read is weaker than the maintainer's: it is an agent's, posted under his login. The list is short for that reason, and holds nothing that decides whether a lens's finding is real.

## The words of each delegation

- Equivalent mutants and policy notices, 2026-10-17: "yes take the authority and run these".
- Refuted injection flags on Melian's own prompts, 2026-11-20, when parking [pull request #590](https://github.com/melian-agent/melian/pull/590).
- The override status, 2026-11-22: "I give you permission to run the override command yourself", then "you may post overrides for these conditions"; and on 2026-11-27, "permission stands".
- Findings that restate a ruling, and the list as a whole, 2026-11-28: "yes".

All were given in the coordinator's session.
