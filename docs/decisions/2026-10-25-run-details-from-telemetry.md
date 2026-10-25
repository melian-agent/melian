# Run details from stage telemetry

Status: accepted by the maintainer, 2026-10-25, in [issue #213](https://github.com/melian-agent/melian/issues/213).

Amends: [Ledger ownership from the posted review](2026-10-06-ledger-review-author.md), the values the visible run details render, which it carries from the ledger projection decision it succeeded.

## Problem

The ledger's run details printed each lens as one run-on bullet: version hash, level, route, model, budgets as raw JSON, raw token counts, dollars to six places, and the standards paths again under every lens. They left out what a reader wants from a run: how long each stage took, what was reused, and the cache share. They also hid an overrun. On [pull request #201](https://github.com/melian-agent/melian/pull/201), `contracts` used 1.54M tokens against a 200k `budget.tokens`, because the budget leaves cache reads out and the page did not say so.

## Decision

1. `melian publish` reads the review's stage telemetry and spans, the record `melian telemetry --json` prints, and stores a projection of it on the publish task's input. The task keeps it on the ledger round, and the ledger renders each round's run from there. A later publish of the same round that cannot read the telemetry keeps the run already stored, so a transient read failure never edits the table away. A stage that ended before the review started counts as reused and costs this review nothing. Verification is one row for all its claims: only the claims this review judged count, and any outcome other than completed among them, such as a budget's end, is the row's.
2. The `<summary>` of the run details is the summary line, so it shows while the details stay folded: review time, tokens with their cache-read share, cost, and each model once with its requested reasoning level and, where it differs, the level the provider reported.
3. Inside: the publisher lines, the policy, the standards the review read, once, and one table with a row per stage: preparation spans as one row, each check, triage, each lens, verification as one row for all its claims, adjudication and the walkthrough. Columns are stage, level, model, time, tokens, cost, outcome and budget.
4. A model stage some of whose requests left no usage marks its token count, and the summary, incomplete, as `melian telemetry` says "usage incomplete". Its tokens and cost are then a floor, never a total.
5. A budget appears only when it matters: at four fifths of its limit or past it, or when it ended the lens. A note under the table says that `budget.tokens` counts input, output and cache-write tokens and never cache reads.
6. Formatting is the same in the ledger and the terminal: whole tokens below a thousand, then `k`, then `M`; cost in cents, with "<$0.01" for less than half a cent; seconds below five minutes, then minutes. `melian telemetry` opens with the same summary line, and `--json` keeps raw numbers.
7. Lens version hashes, routes and the manifest leave the prose. The hidden stamp keeps the lens versions, and the plan's fingerprint keeps the rest. A round published without telemetry, by an older Melian or with none stored, renders as before.

## Stored shapes

The publish task moves to version 7, whose input may carry the run, and the published document to version 10, whose ledger round may hold it. Older shapes have none and read unchanged; `packages/pipeline/test/publish-run-reopen.test.ts` reopens a version-6 input and a version-9 document that main wrote. A telemetry stage of a lens gains its tool calls, its level's budgets and the budget that ended it; telemetry is read from the store each time, so no stored shape changes.
