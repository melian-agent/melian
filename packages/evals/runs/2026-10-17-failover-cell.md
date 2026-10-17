# Live golden run, the Codex-out failover cell, 2026-10-17

When Codex is out, which reviews run? Since [pull request #133](https://github.com/melian-agent/melian/pull/133), a provider usage limit fails over to each tier's next model. On the committed routes that puts an Opus finder on the heavy tier. Terra is a Codex model, so the verifier fails over too, to Sonnet. [The run on main after step 27](2026-10-17-main-after-step-27.md) measured an Opus finder with a Terra verifier, which is not that path. This run measures the path itself: an Opus finder with a Sonnet verifier, three passes each of the design, durability and correctness goldens. Each pass is scored as a corpus. A lens is judged by its worst pass, as [the evals guideline](../../../docs/guidelines/evals.md) requires: worst precision at least 0.8, worst recall at least 0.6.

## Cell

The cell ran at `16bc5737`, the head of `main` the earlier run used. Each invocation is the command below.

```
MELIAN_EVAL_LIVE=1 MELIAN_EVAL_MODEL=anthropic/claude-opus-5-5 MELIAN_EVAL_VERIFIER_MODEL=anthropic/claude-sonnet-5-5 MELIAN_EVAL_GOLDEN=<golden> \
  node --env-file=<file> --conditions=@melian-agent/source packages/evals/src/live.ts
```

It ran on 2026-10-17. No invocation printed an unscored line.

## Corpus precision and recall

Each cell reads precision / recall.

| Corpus | Pass 1 | Pass 2 | Pass 3 | Worst | Mean |
|---|---|---|---|---|---|
| Design (18 expected) | 0.73 / 0.89 | 0.80 / 0.89 | 0.73 / 0.89 | 0.73 / 0.89 | 0.75 / 0.89 |
| Durability (10 expected) | 0.75 / 1.00 | 0.75 / 1.00 | 0.90 / 1.00 | 0.75 / 1.00 | 0.80 / 1.00 |
| Correctness (7 expected) | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |

## What the evidence shows

On the failover path, correctness meets the bar in every pass. Design and durability miss it, at worst precision 0.73 and 0.75. Recall clears the bar on all three lenses.

The Opus finder with a Terra verifier read much the same: design worst 0.70, durability worst 0.73, correctness worst 0.86. So the verifier changes little here, as [the cross-cells run](2026-10-16-finder-verifier-cross-cells.md) found before step 27. The finder sets the precision.

When Codex is out, a review therefore still finds what the goldens hold, since recall is at least 0.89 on every lens. It reports about a quarter more design and durability findings than are real. Readiness question B chose to fail over to Claude rather than leave every merge not reviewed. This run supports that choice, provided the noise is stated.

The run measures the design, durability and correctness lenses only.
