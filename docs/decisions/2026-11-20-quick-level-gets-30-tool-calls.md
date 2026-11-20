# The quick level gets 30 tool calls

Amends: [a lens's token budget fits the requests a review makes](2026-11-18-lens-budgets-fit-the-requests-a-review-makes.md), the quick level's tool-call budget.

Status: proposed for [issue #595](https://github.com/melian-agent/melian/issues/595), awaiting the maintainer's ruling. The coordinator answered on 2026-11-20 to change only this number; that answer is not a ruling, and [pull request #598](https://github.com/melian-agent/melian/pull/598) stays a draft until the maintainer agrees it.

## Problem

Each of Melian's own lenses with a quick level took 10 tool calls from the built-in lenses, and durability set 10 itself. The amended decision raised the quick level's tokens to 1,000,000 and left its tool calls alone. Ten calls is less than a lens needs to read a few files and report.

Example: on [pull request #585](https://github.com/melian-agent/melian/pull/585)'s round, the budget ended `removed-behaviour` at quick after 11 calls and 31,000 tokens, far inside its token budget. It was the only run the present budgets cut across six measured rounds.

## Choice

Every lens file under `.melian/lenses/` with a quick level sets its tool calls to 30. Its tokens stay at 1,000,000. The careful and deep budgets, 3,000,000 tokens and 90 calls, and the design lens's 10,000,000 and 400, stay as they are. The largest careful or deep run measured used 511,000 tokens and 22 calls; [the issue](https://github.com/melian-agent/melian/issues/595#issuecomment-7029003470) has the table.

## What it costs

A quick run can now make three times the calls before it ends. A budget only caps, so a normal round costs the same.
