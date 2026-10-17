# Live golden run, merge by shared cause, 2026-10-17

Did merging reports that one hunk caused improve the Opus finder's precision? Five Opus design passes and one durability pass ran after [pull request #131](https://github.com/melian-agent/melian/pull/131). Each invocation reviewed one golden. `tmp/m2/score-cells.py` scored each pass as a corpus, adding counts before it divided, as [the evals guideline](../../docs/guidelines/evals.md) requires.

## Cells

Every cell used `anthropic/claude-opus-5-5` as finder and `openai-codex/gpt-5.6-terra` as verifier. The design passes ran at three heads on the pull request: `a6643259`, `65922d2a` and `54e2a980`. The durability pass ran at `ed03b2ea`. One pass at `a6643259` left `design-single-slot-overwrite` unscored because the verifier did not judge every claim; the scorer excludes it from that pass's totals.

| Corpus | Head | Passes | Precision / recall | Reported / expected |
|---|---:|---:|---|---:|
| Design | a6643259 | 1 | 0.76 / 0.89 | 21 / 18 |
| Design | a6643259 | 2 | 0.73 / 0.94 | 22 / 17 |
| Design | 65922d2a | 1 | 0.80 / 0.89 | 20 / 18 |
| Design | 54e2a980 | 1 | 0.71 / 0.94 | 24 / 18 |
| Design | 54e2a980 | 2 | 0.82 / 1.00 | 22 / 18 |
| Durability | ed03b2ea | 1 | 0.90 / 1.00 | 10 / 10 |

## What the evidence shows

The five design passes have mean precision 0.76. Before the structural merge, Opus design precision was about 0.52 in [the cross-cells run](2026-10-16-finder-verifier-cross-cells.md) and [the citation-sentence run](2026-10-16-citation-sentence.md). The durability pass reached 0.90 precision, above its earlier Opus range of 0.53 to 0.75 in the cross-cells run.

The samples use different pull-request heads and one durability pass. They show an improvement after the structural merge, not a controlled attribution of every change on those heads. All runs used Pi's pre-1.1.0 prompt layout; [pull request #136](https://github.com/melian-agent/melian/pull/136) moved the lens brief into system instructions.
