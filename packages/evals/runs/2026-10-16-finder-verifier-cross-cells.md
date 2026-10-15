# Live golden run, finder and verifier cross cells, 2026-10-16

Which model finds, and which verifies, decides a lens's precision? Five cells cross two finders with two verifiers on the design, durability and correctness goldens. One golden per invocation, scored as a corpus as [the evals guideline](../../docs/guidelines/evals.md) sets out: counts add before they divide.

## Cells

Three cells ran on `main` at 69475b44, the merge of [pull request #121](https://github.com/melian-agent/melian/pull/121), with a Sol finder and a Terra verifier, a Sol finder and a Sonnet verifier, and an Opus finder and a Terra verifier. Two cells ran at 5d75fed3, before #121's lens-prompt change. Each invocation is the command below, with the finder in `MELIAN_EVAL_MODEL` and the verifier in `MELIAN_EVAL_VERIFIER_MODEL`:

```
MELIAN_EVAL_LIVE=1 MELIAN_EVAL_MODEL=<finder> MELIAN_EVAL_VERIFIER_MODEL=<verifier> MELIAN_EVAL_GOLDEN=<golden> \
  node --env-file=<file> --conditions=@melian-agent/source packages/evals/src/live.ts
```

| Cell | Finder | Verifier | Head | Passes |
|---|---|---|---|---|
| Sol, Terra | `openai-codex/gpt-6.1-sol` | `openai-codex/gpt-5.6-terra` | 69475b44 | 3 |
| Sol, Sonnet | `openai-codex/gpt-6.1-sol` | `anthropic/claude-sonnet-5-5` | 69475b44 | 2 |
| Opus, Terra | `anthropic/claude-opus-5-5` | `openai-codex/gpt-5.6-terra` | 69475b44 | 2 |
| Opus | `anthropic/claude-opus-5-5` | not recorded | 5d75fed3 | 2 |
| Control | `anthropic/claude-sonnet-5-5` | `anthropic/claude-opus-5-5` | 5d75fed3 | 2 |

The `Opus` cell's output does not record its models, and the Opus finder is the coordinator's account of it. The control ran the design and durability goldens only. The three 69475b44 cells ran 09:00 to 09:38 on 2026-10-16; the two older cells ran on 2026-10-15. The driver is `tmp/m2/live-goldens-cross.sh` and the scorer `tmp/m2/score-cells.py`, which weights each golden's precision by its reported count and its recall by its expected count. No cell printed an unscored line.

## Corpus precision and recall

A cell reads precision / recall.

### Design (18 expected)

| Cell | Pass 1 | Pass 2 | Pass 3 | Reported per pass |
|---|---|---|---|---|
| Sol, Terra | 0.90 / 1.00 | 0.86 / 1.00 | 0.85 / 0.94 | 20, 21, 20 |
| Sol, Sonnet | 0.90 / 1.00 | 0.85 / 0.94 | | 20, 20 |
| Opus, Terra | 0.52 / 0.89 | 0.51 / 0.94 | | 31, 33 |
| Opus (5d75fed3) | 0.59 / 0.89 | 0.52 / 0.83 | | 27, 29 |
| Control (5d75fed3) | 0.52 / 0.89 | 0.50 / 0.94 | | 31, 34 |

### Durability (10 expected)

| Cell | Pass 1 | Pass 2 | Pass 3 | Reported per pass |
|---|---|---|---|---|
| Sol, Terra | 1.00 / 1.00 | 0.89 / 0.90 | 0.89 / 0.90 | 9, 9, 9 |
| Sol, Sonnet | 0.89 / 0.90 | 1.00 / 1.00 | | 9, 9 |
| Opus, Terra | 0.75 / 1.00 | 0.61 / 0.90 | | 12, 13 |
| Opus (5d75fed3) | 0.53 / 1.00 | 0.69 / 1.00 | | 17, 13 |
| Control (5d75fed3) | 0.50 / 0.90 | 0.57 / 0.90 | | 16, 14 |

### Correctness (7 expected at 69475b44, 4 at 5d75fed3)

| Cell | Pass 1 | Pass 2 | Pass 3 | Reported per pass |
|---|---|---|---|---|
| Sol, Terra | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 6, 6, 6 |
| Sol, Sonnet | 1.00 / 1.00 | 1.00 / 1.00 | | 6, 6 |
| Opus, Terra | 1.00 / 1.00 | 1.00 / 1.00 | | 6, 6 |
| Opus (5d75fed3) | 1.00 / 1.00 | 1.00 / 1.00 | | 3, 3 |

#121 added three correctness expectations in `correctness-repeated-shape`, so the 5d75fed3 counts are smaller by construction.

## What the evidence shows

- The heavy finder decides design and durability precision. On design, Sol sits at 0.85 to 0.90 and Opus at 0.51 to 0.52, a lead of about 0.35, with a Terra or a Sonnet verifier alike. On durability Sol averages about 0.94 over its five passes and Opus 0.68 over two, a lead of about 0.25. Swapping the verifier moves Sol by less than the pass-to-pass spread.
- Opus over-reports on design: 31 and 33 findings against 18 expected, where Sol reports 20 or 21. Its recall is no better than Sol's, so the extra findings are noise.
- Correctness ties. Every cell scores 1.00 and 1.00.
- Sol with Terra at 69475b44 matches the earlier Sol runs, such as [the design run with the Terra verifier](2026-10-12-live-goldens-design-terra.md) at 0.76 to 0.83 precision over fewer goldens. #121 caused no regression in the committed routes.

## Confound

The two 5d75fed3 cells ran before #121 changed the lens prompts, and on a different corpus: they miss the three goldens #121 added. They also ran on the previous evening, and the `Opus` cell's verifier is not recorded. They show the Opus finder's behaviour on the old prompts only. The Opus finder's weak design precision recurs at 69475b44 (Opus, Terra cell), so the finder explains it rather than the prompts, but the 5d75fed3 cells cannot be pooled with the rest. The control changes both the finder and the verifier against the others, so it isolates neither.

Two passes per cell, and three for one, is a small sample. Adjudicated precision was not measured: an extra finding may be a real defect or a co-report.
