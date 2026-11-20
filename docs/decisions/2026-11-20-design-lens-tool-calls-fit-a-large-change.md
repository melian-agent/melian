# The design lens's tool-call limit fits a large change

Status: proposed by the coordinator on 2026-11-20; it lands only on the maintainer's word.

Amends: [A lens's token budget fits the requests a review makes](2026-11-18-lens-budgets-fit-the-requests-a-review-makes.md), the design lens's tool-call budget.

## Problem

That decision raised the design lens's token budget to 10,000,000 and left its tool-call budget at 400. A lens ends at whichever limit it meets first, and a review with an ended lens reads not reviewed.

Example: on [pull request #551](https://github.com/melian-agent/melian/pull/551), at 764b78e4, the design lens finished with 357 of its 400 tool calls and 5,270,895 of its 10,000,000 budgeted tokens. On [pull request #532](https://github.com/melian-agent/melian/pull/532), a larger change, it ended, and the round cost $45.92 and could not pass.

## Choice

The design lens's tool-call budget is 600. Its token and findings budgets stay as they are. At the rate #551 showed, about 15,000 budgeted tokens a call, 600 calls use about 9,000,000 tokens, so the two limits now meet at about the same size of change.

## What it gives up

A round on a very large change can cost more before the lens stops. The lens that reads the design is most of a round's cost: $28.58 of $34.59 on #551.
