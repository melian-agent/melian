# A lens's token budget fits the requests a review makes

Status: the maintainer ruled on 2026-11-18, in the coordinator session, to raise every committed lens's token budget, under his goal of the same day, parity with the review of record first and cost afterwards, which [pull request #508](https://github.com/melian-agent/melian/pull/508) records.

## Problem

Each lens of Melian's `full` tier had a budget of 600,000 tokens, and the design lens 5,000,000. A lens's every request carries its instructions, and those hold the repository's standards: `AGENTS.md` and the guidelines, about 180,000 tokens. With the diff, a request is about 230,000 tokens. So an ordinary lens could afford a few requests, and then it ended.

Example: on [pull request #532](https://github.com/melian-agent/melian/pull/532) the probing lens's planner ended after four tool calls, at 1,278,452 tokens, and the review read not reviewed. The design lens ended at its budget on that pull request, on [#550](https://github.com/melian-agent/melian/pull/550) and on [#575](https://github.com/melian-agent/melian/pull/575), the same day. The reviews of record on those pull requests made 52 to 64 tool calls each.

## Choice

Every lens file under `.melian/lenses/` that set 600,000 tokens sets 3,000,000, and the design lens sets 10,000,000. At about 230,000 tokens a request, that is about a dozen requests for an ordinary lens and about forty for the design lens. Each lens's `quick` level sets 1,000,000 where it had 100,000, which was less than one request; the design lens has no quick level. The findings and tool-call budgets stay as they were.

## What it costs

A round on a large pull request can cost more, until the standards a lens is sent shrink. That is the follow-up, [issue #580](https://github.com/melian-agent/melian/issues/580), and the better fix: the standards are about three quarters of every request.

A budget in tokens bounds spend, not work. While most of a request is the same standards sent again, the number says little about how much of the change a lens read.
