# Convergence rules for the review loop

Problem: milestone 2's review loop fixed each finding as it came, and some pull requests never converged. Each round found one more instance, each fix pass added code the next round found wanting, and the rounds grew slower as the branches grew.

Example: [pull request #102](https://github.com/melian-agent/melian/pull/102) took eighteen rounds while its hand-built Markdown line reconstruction met a new shape each round. [Pull request #98](https://github.com/melian-agent/melian/pull/98) hand-parsed Vitest's configuration for four rounds and inferred whose code a head is from git metadata for four more, at 13,000 changed lines and one to two hours a round. [Pull request #116](https://github.com/melian-agent/melian/pull/116) matched names in text to re-scope a finding for five reviews. [Pull request #112](https://github.com/melian-agent/melian/pull/112) took three passes over an unconfined fallback the maintainer then removed. Four coordinator rulings on trust or blocking behaviour each cost a round when the next round broke them.

Choice: six rules, which `AGENTS.md` states for the coordinator and every brief.

1. Escalate a class, not an instance. When two consecutive rounds each find a new instance of one class of defect, stop fixing instances. Raise the class as a design question that names the authority, or the stricter rule, that would make the class impossible.
2. Fix with the least new code. A fix that needs a new mechanism is a design question, raised before the pass. A brief names the files and lines a fix may touch. Once the mutation check is on `main`, the fix commits pass it before they are pushed.
3. A ruling that changes trust or blocking behaviour gets a short attacking review before a fix pass implements it.
4. Split a pull request over about 3,000 changed lines.
5. A review of record on a trust surface attacks with probes and does not only read.
6. Rounds sample, so one clean round depends on what the lenses read. Until [delta re-review](2026-10-15-delta-re-review.md) exists, the last round before the queue is a full one.

Why rules and not judgement: each of these was a judgement the coordinator could have made and did not, round after round, because each finding was a true defect. Only the count showed that the approach was the defect, as [the ask-the-authority decision](2026-10-12-ask-the-authority.md) found for hand parsers.

What this gives up: escalation stops work until a maintainer answers, and a split adds a stacked pull request and a second set of reviews. An attacking review of a ruling delays the fix pass by one short review. Some classes end after a third instance without escalation; the rule spends a maintainer's attention on them anyway.
