# Builders run the review of record from a fixed brief

Amends: [docs/decisions/2026-10-15-review-loop-convergence-rules.md](2026-10-15-review-loop-convergence-rules.md), who runs the review of record

The maintainer ruled on 2026-11-08 that the builder starts the review of record, from [the review-of-record brief](../review-of-record.md), instead of the coordinator.

## Why

The review of record was the last review the coordinator ran by hand. Each one waited for the coordinator's machine and attention, and today three of them queued behind the host's load. Nothing technical kept it on the host once a cloud session's gate passes, which [pull request #329](https://github.com/melian-agent/melian/pull/329) brings. A cloud VM is a better place for probes than the coordinator's machine: it is isolated and competes with nothing.

What the coordinator gave the review was independence. It wrote each brief from the issue, the rulings and the diff, never from the builder's reasoning. A fixed brief keeps that: the builder fills in the pull request's number, head and model, and adds no analysis of its own. The fresh-context agent reads everything else from GitHub and the repository, so the builder's view never steers what it attacks.

## The rule

- The builder starts a fresh-context agent with the brief and three values, after Codex's review and the first Melian round.
- Sonnet 5.5 runs it, and Opus 5.5 on a trust surface, as the brief defines one.
- The builder posts the report and its JSON unchanged, and fixes each finding with a failing test first. A disputed finding is answered on the pull request, never dropped.
- The coordinator imports the JSON into the comparison record and spot-checks a sample of reviews. A spot check that finds a review was steered, or skipped what the brief requires, sends the pull request back for a fresh one.
- The brief changes only through a pull request, so a builder never edits the instructions its own reviewer follows.
