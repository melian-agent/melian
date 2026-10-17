# Live golden run, main after step 27 and Pi 1.1.0, 2026-10-17

How do Opus and Sol score once the merged code holds the merge by shared cause and Pi 1.1.0's prompt layout? Two cells ran the design and durability goldens on one head of `main`, two passes each. They replace the association that [the merge-by-shared-cause run](2026-10-17-merge-by-shared-cause.md) reported across the changing heads of [pull request #131](https://github.com/melian-agent/melian/pull/131). One golden ran per invocation, scored as a corpus as [the evals guideline](../../../docs/guidelines/evals.md) describes.

## Cells

Both cells ran at `16bc5737`, which holds [pull request #131](https://github.com/melian-agent/melian/pull/131) (merge by shared cause), [pull request #135](https://github.com/melian-agent/melian/pull/135) (stage telemetry) and [pull request #136](https://github.com/melian-agent/melian/pull/136) (Pi 1.1.0, which sends each lens brief as the system instructions). Each invocation is the command below, with the finder in `MELIAN_EVAL_MODEL` and the verifier in `MELIAN_EVAL_VERIFIER_MODEL`.

```
MELIAN_EVAL_LIVE=1 MELIAN_EVAL_MODEL=<finder> MELIAN_EVAL_VERIFIER_MODEL=<verifier> MELIAN_EVAL_GOLDEN=<golden> \
  node --env-file=<file> --conditions=@melian-agent/source packages/evals/src/live.ts
```

| Cell | Finder | Verifier | Passes |
|---|---|---|---|
| Opus, Terra | `anthropic/claude-opus-5-5` | `openai-codex/gpt-5.6-terra` | 2 |
| Sol, Terra | `openai-codex/gpt-6.1-sol` | `openai-codex/gpt-5.6-terra` | 2 |

The cells ran in parallel on 2026-10-17. No invocation printed an unscored line.

## Corpus precision and recall

A cell reads precision / recall, with reported against expected findings.

### Design (18 expected)

| Cell | Pass 1 | Pass 2 | Before step 27, from [the cross-cells run](2026-10-16-finder-verifier-cross-cells.md) |
|---|---|---|---|
| Opus, Terra | 0.89 / 0.94, 19 | 0.70 / 0.89, 23 | 0.52 / 0.89, 0.51 / 0.94 |
| Sol, Terra | 0.85 / 0.94, 20 | 0.86 / 1.00, 21 | 0.90 / 1.00, 0.86 / 1.00, 0.85 / 0.94 |

### Durability (10 expected)

| Cell | Pass 1 | Pass 2 | Before step 27 |
|---|---|---|---|
| Opus, Terra | 0.75 / 1.00, 12 | 0.82 / 1.00, 11 | 0.75 / 1.00, 0.61 / 0.90 |
| Sol, Terra | 1.00 / 1.00, 9 | 1.00 / 1.00, 9 | 1.00 / 1.00, 0.89 / 0.90, 0.89 / 0.90 |

## What the evidence shows

On design, Opus averaged 0.80 over the two passes, against 0.52 before step 27, at the same recall. Its passes spread widely, 0.89 and 0.70, so two passes put the mean within about 0.1. Sol held at 0.85 and 0.86.

On durability, Opus averaged 0.79, against 0.61 to 0.75 before. Sol reached 1.00 in both passes. Durability is where the two finders still differ most.

Sol lost nothing to the new layout or to the merge. The correctness lens's sentence from [pull request #136](https://github.com/melian-agent/melian/pull/136) kept the clean `reimplements-an-authority` golden quiet in both Sol passes.

So the merged code puts Opus within about 0.05 of Sol on design precision, by the mean, and about 0.2 below it on durability. That supports failing over to Claude for every lens when Codex is out, as readiness question B recorded. It also supports keeping Sol first on the heavy tier.

Two passes per cell cannot separate the effect of step 27 from that of the Pi layout change, since both landed between the earlier runs and this one.
