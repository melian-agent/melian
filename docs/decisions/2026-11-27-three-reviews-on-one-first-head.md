# The three reviews run first on one head

Status: ruled by the maintainer on 2026-11-27, in the coordinator's session. The coordinator proposed it; the maintainer asked for the draft and agreed its text that day.

Amends: [Builders run their own reviews](2026-11-05-builders-run-their-own-reviews.md), when Codex's review runs: once, on the first reviewed head, where it said before the first round and after each fix pass
Amends: [Builders run the review of record](2026-11-08-builders-run-the-review-of-record.md), when the review of record runs: on the first reviewed head, beside the other two, where it said after Codex's review and the first Melian round

## Problem

Every pull request gets Codex's adversarial review, a Melian round and the Claude review of record. AGENTS.md ran them one after another: Codex first, then its fixes, then a round, then its fixes, then the review of record. Each reviewer saw different code. A defect Codex found was fixed before Melian's round ran, so the round could neither find it nor miss it.

Example: the maintainer's parity loop needed to know which defects each reviewer finds. For the three pull requests it measured, [#613](https://github.com/melian-agent/melian/pull/613), [#619](https://github.com/melian-agent/melian/pull/619) and [#623](https://github.com/melian-agent/melian/pull/623), the coordinator had to run each reviewer again, blind, on one old head, and build each defect list by hand. About forty pull requests merged between 2026-11-04, the date of the newest comparison record, and 2026-11-27 with all three reviews posted and nothing that could compare them.

## Choice

The three reviews run first on one commit: the first head the builder pushes with its gate green, or with CI green on it where the gate cannot run. The builder starts all three together, pushes no fix until all three have reported, and names the commit in its report as the first reviewed head.

After that head, each fix pass gets a Melian round and nothing else. Codex's review and the review of record run once, on the first reviewed head. The maintainer ruled this on 2026-11-28, in the coordinator's session: "we've reached a level of recall that I'm satisfied with only using All 3 models for that first code review to build up our parity database. Following fixes, lets just use the melian review." The cost is accepted: no reviewer but Melian reads a fix commit, where Codex's review used to run after each fix pass and the review of record, running last, used to read most of them.

After the merge, the coordinator has a Sonnet agent draft the pull request's defect list for its comparison record: each distinct finding a reviewer raised on the first reviewed head, who raised it, and the commit that answered it or the builder's reply disputing it. The draft is evidence for adjudication, never the adjudication. Each finding is still judged valid, noise or duplicate as [the evals guideline](../guidelines/evals.md#comparisons) sets out, and [the shadow retirement rule](2026-10-06-shadow-retirement-merged-window.md) counts what it counted before: this decision changes neither.

## Why

- The fix commits are evidence nobody has to write. AGENTS.md already requires a failing test before a fix, so a fixed finding comes with a test that failed at the reviewed head. That is strong evidence and not proof: Melian's own status makes a builder answer every acknowledge and blocking finding, so a builder may fix noise because fixing is cheaper than disputing. Melian's first round on this decision's own pull request raised exactly that, and the text changed to keep adjudication where it was.
- All three reviews already run, so the comparison costs only the draft list, about a dollar a pull request, and the adjudication the rules already ask for.
- Starting the three together is faster than running them in turn.
- Ten such pull requests are also the window [the shadow retirement rule](2026-10-06-shadow-retirement-merged-window.md) asks for, measured on like for like.

## What it costs

- A defect one reviewer finds is no longer fixed before the next reviewer runs, so two reviewers may report it. The comparison record already counts a defect once however many report it.
- The first round reviews a head no review has improved, so it may raise more findings than a first round does today.
- Only the first head is compared. Later rounds on fix commits stay uncompared, as they are now.

## What does not change

The review of record's brief, its independence and its model. Who runs each review. The rules for marking a pull request ready and queueing it. The coordinator's spot check and its remedy: a review of record the spot check finds steered, run on the wrong model, or short of what the brief requires is void, and a fresh one runs on the same first reviewed head. That is no second review of a reviewed change, since the void one reviewed nothing that counts; this reading of the ruling is the coordinator's.

## What this retires

Taking Codex's review and the review of record off fix commits is a partial retirement of both, ruled by the maintainer outside [the shadow retirement rule](2026-10-06-shadow-retirement-merged-window.md). That rule's measured criterion, ten merged pull requests at recall 0.75 or better, still decides when Codex's review stops running on the first head.
