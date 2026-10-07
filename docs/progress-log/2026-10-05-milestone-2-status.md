A snapshot of milestone 2 at the end of 2026-10-05, so the next session reads it here and not from memory.

## What landed today

Twenty-one pull requests, [#51](https://github.com/melian-agent/melian/pull/51) to [#71](https://github.com/melian-agent/melian/pull/71), closed or advanced these steps.

- Step 12, domain objects carry behaviour: [#51](https://github.com/melian-agent/melian/pull/51), with its follow-ups in [#56](https://github.com/melian-agent/melian/pull/56).
- Step 13, per-file hand-offs: [#57](https://github.com/melian-agent/melian/pull/57).
- Step 4, the review plan: [#61](https://github.com/melian-agent/melian/pull/61).
- The dist dev loop: [#55](https://github.com/melian-agent/melian/pull/55) runs the CLI from source in a checkout and builds `dist` only to publish.
- The guardrails: [#66](https://github.com/melian-agent/melian/pull/66) adds bare issue references and overlong sentences in docs, and [#70](https://github.com/melian-agent/melian/pull/70) stops a semicolon counting as a seam.
- Step 9, the glob half of [#22](https://github.com/melian-agent/melian/issues/22): [#60](https://github.com/melian-agent/melian/pull/60).
- The first backlog drain: [#71](https://github.com/melian-agent/melian/pull/71), two goldens owed since [#65](https://github.com/melian-agent/melian/pull/65) set the rule.
- Comparison as a capability, the design: [#65](https://github.com/melian-agent/melian/pull/65).
- The records for earlier pull requests: [#53](https://github.com/melian-agent/melian/pull/53), [#54](https://github.com/melian-agent/melian/pull/54), [#58](https://github.com/melian-agent/melian/pull/58), [#59](https://github.com/melian-agent/melian/pull/59), [#63](https://github.com/melian-agent/melian/pull/63), and [#64](https://github.com/melian-agent/melian/pull/64).
- A trap noted in the agent guide: [#52](https://github.com/melian-agent/melian/pull/52).

Two steps are pending. Step 8, the ledger, is [#73](https://github.com/melian-agent/melian/pull/73). Step 15's first part is [#68](https://github.com/melian-agent/melian/pull/68), with its second part in [#72](https://github.com/melian-agent/melian/pull/72). Step 5 is [#62](https://github.com/melian-agent/melian/pull/62). [#67](https://github.com/melian-agent/melian/pull/67) and [#69](https://github.com/melian-agent/melian/pull/69) hold the records for [#62](https://github.com/melian-agent/melian/pull/62) and [#68](https://github.com/melian-agent/melian/pull/68).

## Recall and precision

Three records measure Melian against Codex and the Opus review.

- [#61](https://github.com/melian-agent/melian/pull/61): eighty-five of ninety-six, at a precision of eighty-five of eighty-five, over eleven rounds. This one is closed.
- [#62](https://github.com/melian-agent/melian/pull/62): twenty-seven of forty-four, at a precision of twenty-seven of twenty-seven, after three rounds. The counts stay provisional until the fourth.
- [#68](https://github.com/melian-agent/melian/pull/68): twenty-one of forty, at a precision of twenty-one of twenty-one, after three rounds. The counts stay provisional until the final round.

Recall climbs with each round, because each fix pass writes code that the next round reads for the first time. Precision has held at one on all three.

## Two experiments

- **Sonnet 5.5 as the review of record.** The record for [#73](https://github.com/melian-agent/melian/pull/73) decides it, where Sonnet ran beside the Opus review.
- **Codex for implementation.** The records for [#72](https://github.com/melian-agent/melian/pull/72) and [#73](https://github.com/melian-agent/melian/pull/73) decide it, against Opus-written pull requests of similar size.

[AGENTS.md](../../AGENTS.md#delegation-and-the-review-loop) states the lanes and the review loop. The plan's [in-flight block](../design-implementation-plan.md#milestone-2-in-flight-2026-10-07) lists the open pull requests.

## Next three actions

1. Land [#62](https://github.com/melian-agent/melian/pull/62), then run [#68](https://github.com/melian-agent/melian/pull/68)'s final round. Its record in [#69](https://github.com/melian-agent/melian/pull/69) and [#62](https://github.com/melian-agent/melian/pull/62)'s in [#67](https://github.com/melian-agent/melian/pull/67) follow.
2. Finish the fix passes on [#72](https://github.com/melian-agent/melian/pull/72) and [#73](https://github.com/melian-agent/melian/pull/73), and judge the two experiments from their records.
3. Start step 6, the verifier, now that step 4 has landed.
