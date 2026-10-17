# Live golden run, main after step 27 and Pi 1.1.0, 2026-10-17

How do Opus and Sol finders score on the merged code? Two cells ran the design, durability and correctness goldens three times each on one head of `main`. That head holds the merge by shared cause and Pi 1.1.0's prompt layout. The run replaces the association that [the merge-by-shared-cause run](2026-10-17-merge-by-shared-cause.md) reported across the changing heads of [pull request #131](https://github.com/melian-agent/melian/pull/131). One golden ran per invocation. Each pass is scored as a corpus, and a lens is judged by its worst pass, as [the evals guideline](../../../docs/guidelines/evals.md) requires: worst precision at least 0.8 and worst recall at least 0.6.

## Cells

Both cells ran at `16bc5737`. That head holds three changes:
- [pull request #131](https://github.com/melian-agent/melian/pull/131), merge by shared cause;
- [pull request #135](https://github.com/melian-agent/melian/pull/135), stage telemetry;
- [pull request #136](https://github.com/melian-agent/melian/pull/136), Pi 1.1.0 with its correctness-lens sentence. It sends each lens brief as the system instructions.

Each invocation is the command below, with the finder in `MELIAN_EVAL_MODEL` and the verifier in `MELIAN_EVAL_VERIFIER_MODEL`.

```
MELIAN_EVAL_LIVE=1 MELIAN_EVAL_MODEL=<finder> MELIAN_EVAL_VERIFIER_MODEL=<verifier> MELIAN_EVAL_GOLDEN=<golden> \
  node --env-file=<file> --conditions=@melian-agent/source packages/evals/src/live.ts
```

| Cell | Finder | Verifier | Passes per corpus |
|---|---|---|---|
| Opus, Terra | `anthropic/claude-opus-5-5` | `openai-codex/gpt-5.6-terra` | 3 |
| Sol, Terra | `openai-codex/gpt-6.1-sol` | `openai-codex/gpt-5.6-terra` | 3 |

The cells ran on 2026-10-17. No invocation printed an unscored line. The correctness corpus includes `correctness-refuses-unrecognised-input-clean`, which #136 added.

## Corpus precision and recall

Each cell reads precision / recall.

### Design (18 expected)

| Cell | Pass 1 | Pass 2 | Pass 3 | Worst | Mean precision |
|---|---|---|---|---|---|
| Opus, Terra | 0.89 / 0.94 | 0.70 / 0.89 | 0.85 / 0.94 | 0.70 / 0.89 | 0.81 |
| Sol, Terra | 0.85 / 0.94 | 0.86 / 1.00 | 0.95 / 1.00 | 0.85 / 0.94 | 0.89 |

### Durability (10 expected)

| Cell | Pass 1 | Pass 2 | Pass 3 | Worst | Mean precision |
|---|---|---|---|---|---|
| Opus, Terra | 0.75 / 1.00 | 0.82 / 1.00 | 0.73 / 0.90 | 0.73 / 0.90 | 0.77 |
| Sol, Terra | 1.00 / 1.00 | 1.00 / 1.00 | 0.89 / 0.90 | 0.89 / 0.90 | 0.96 |

### Correctness (7 expected)

| Cell | Pass 1 | Pass 2 | Pass 3 | Worst | Mean precision |
|---|---|---|---|---|---|
| Opus, Terra | 0.86 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 0.86 / 1.00 | 0.95 |
| Sol, Terra | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 |

## What the evidence shows

Sol meets the bar on all three lenses.

Opus meets it on correctness. On design and durability it misses it, with worst precision 0.70 and 0.73, though its recall clears the bar on all three. Before step 27, [the cross-cells run](2026-10-16-finder-verifier-cross-cells.md) had Opus's design precision at 0.52 and 0.51. Its mean is now 0.81, so its precision has risen, but one pass in three still drops below 0.8.

The clean golden `design-reimplements-an-authority-clean` scored clean in all three Sol passes. A run with `MELIAN_EVAL_SHOW=1` showed no finding. The scorer and that output both leave out findings the verifier refuted, so this run cannot tell a silent correctness lens from one whose report the verifier caught.

These results support three things:
- **Routing:** Sol stays first on the heavy tier.
- **Failover:** falling back to Opus when Codex is out is sound for correctness. For design and durability it gives a useful but noisier review, below the bar in some passes.
- **What is not shown:** the run measures the design, durability and correctness lenses only, and says nothing about the others.

The run does not separate the effect of step 27 from that of the Pi layout change, since both landed between the earlier runs and this one.
