# What the coordinator may do for the maintainer

Status: ruled by the maintainer on 2026-11-29, in the coordinator's session. The coordinator set out three options after two review rounds on this decision's own pull request; he chose the one below, with "agree with all" to the coordinator's recommendations.

Amends: [A verifier cannot clear a protected objection without a maintainer](2026-10-17-trust-floor-exact-rule.md), who dismisses a refuted `melian/injection-attempt` finding: the coordinator may, only where every flagged line is a line of Melian's own prompt text that the same change moved unchanged

## Problem

Since 2026-10-17 the maintainer had delegated some of his reads and dismissals to the coordinator, one at a time, in the coordinator's session. Nothing in the repository said so. A builder cannot check a delegation it cannot read, and the coordinator and the maintainer post under one login.

Example: on [pull request #662](https://github.com/melian-agent/melian/pull/662), the round's only finding above advisory was a policy notice on one new learning in AGENTS.md. The coordinator read the change and recorded its read. The builder declined to queue on it, rightly, and the pull request waited for the maintainer to answer "read".

The first draft of this decision wrote down five delegations as the coordinator held them. Two Melian rounds, Codex's review and the review of record found that three of them contradicted active decisions, and that each narrowing left a new hole. Each was defined by a kind of file or a kind of finding, and rested on the coordinator judging a change harmless:

- A read of a policy notice reached `melian.yaml` and every `LENS.md`, which decide what blocks. Limited to new Learnings in AGENTS.md, it still reached any rule a builder wrote as a learning.
- The override status, posted after a round that ran, cleared a blocking notice that [the acknowledge rule](2026-10-17-acknowledge-status-exact-rule.md) says only a stored dismissal clears. That includes a notice naming a switched-off check, where green CI proves nothing, since the head's own configuration produced it.
- Dismissing a finding that "restates a ruling" decides the finding is not new, which is the judgement a dismissal exists to ask of a person.

## Choice

The coordinator may do two things in the maintainer's place, and nothing else:

1. **Dismiss an equivalent mutant**: a surviving-mutant finding of the mutation check, with a one-line reason that says why no input can tell the mutant from the code.
2. **Dismiss a refuted injection flag on a prompt line that only moved.** The finding is a `melian/injection-attempt` the verifier refuted. Every flagged line is in Melian's own prompt text, and the same change deletes that line from one place in Melian's prompt text and adds it, identical, in another. The test is a comparison of the change's own diff, never the coordinator's judgement of meaning. A line the change wrote, reworded or copied from elsewhere stays the maintainer's.

The coordinator never does either on a pull request it wrote. Each act is posted beginning "Coordinator:", says which of the two it is, and never says the maintainer did it.

Everything else stays the maintainer's, and the permissions he gave in the coordinator's session for these are withdrawn:

- **Every policy notice is his to read**, on AGENTS.md, a lens file, a policy file or any other. The coordinator's recorded read counts for nothing, and a builder never queues on it.
- **The override status is his to post**, as [the outage procedure](2026-10-23-melian-review-outage-procedure.md) says. The coordinator posts it on no commit.
- **A finding that restates a ruling is his to dismiss.**
- An acknowledge or blocking finding from a lens, a mutant that is not equivalent, an injection flag on any other text, and a new ruling were his before and remain so.
- A change to this decision, or to the lines of AGENTS.md that state it, is his to read.

The coordinator makes his part cheap. For each read or dismissal it sends one message that names the pull request, quotes the changed lines or the finding, and can be answered in a word. It records his answer on the pull request with its date and where he gave it.

## Why

- A delegation is safe only where a mechanical test decides it. An equivalent mutant carries a written proof a reviewer can check. A moved line is a fact about the diff. The three withdrawn delegations each needed an agent's judgement that a change was harmless, on the files where a wrong judgement removes the check on every later change.
- They saved little. The case that began this, a new learning in AGENTS.md, cannot be delegated at all: a learning is an instruction to every agent.
- A rule in the repository can be checked by the builder it affects and reviewed like any other. One held in a session's memory can be neither, and here it had drifted from the decisions in force.

## What it costs

The maintainer reads every policy notice and dismisses every restated ruling himself: a few messages a week. A blocking policy notice waits for his dismissal or his override.

## The earlier permissions, now replaced

All were given in the coordinator's session.

- Equivalent mutants and policy notices, 2026-10-17: "yes take the authority and run these". The first stands; the second is withdrawn.
- Refuted injection flags on Melian's own prompts whose meaning is unchanged, 2026-11-20, when parking [pull request #590](https://github.com/melian-agent/melian/pull/590). The coordinator kept no quote of his words that day. Narrowed here to lines that only moved.
- The override status, 2026-11-22: "I give you permission to run the override command yourself", and on 2026-11-27, "permission stands". Withdrawn. The coordinator used it on [pull request #603](https://github.com/melian-agent/melian/pull/603), which stands as merged.
