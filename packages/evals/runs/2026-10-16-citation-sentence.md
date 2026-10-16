# Live golden run, the citation sentence, 2026-10-16

Does telling every lens to put a finding on the lines that break make Opus finders cite one snippet, so the merge joins one defect's reports? Two cells ran the design goldens at the head that added the sentence, and compare with the same cells in [the cross-cells record](2026-10-16-finder-verifier-cross-cells.md). One golden per invocation, scored as a corpus as [the evals guideline](../../docs/guidelines/evals.md) sets out: counts add before they divide.

## Cells

Both cells ran at bb8c0100 on the branch of [pull request #130](https://github.com/melian-agent/melian/pull/130). That head added one sentence to Melian's fixed lens instructions: "Put `line` and `endLine` on the line or lines that break, and cite any wider span as evidence." Each invocation is the command below, with the finder in `MELIAN_EVAL_MODEL` and the verifier in `MELIAN_EVAL_VERIFIER_MODEL`:

```
MELIAN_EVAL_LIVE=1 MELIAN_EVAL_MODEL=<finder> MELIAN_EVAL_VERIFIER_MODEL=<verifier> MELIAN_EVAL_GOLDEN=<golden> \
  node --env-file=<file> --conditions=@melian-agent/source packages/evals/src/live.ts
```

| Cell | Finder | Verifier | Head | Passes |
|---|---|---|---|---|
| Opus, Terra | `anthropic/claude-opus-5-5` | `openai-codex/gpt-5.6-terra` | bb8c0100 | 2 |
| Sol, Terra | `openai-codex/gpt-6.1-sol` | `openai-codex/gpt-5.6-terra` | bb8c0100 | 1 |

The cells ran in parallel from a worktree of their own, from 15:52 to 16:22 on 2026-10-16. The driver is `tmp/m2/live-goldens-130.sh`, which runs every golden named `design-`. No invocation printed an unscored line.

## Corpus precision and recall

### Design (18 expected)

A cell reads precision / recall.

| Cell | Pass 1 | Pass 2 | Reported per pass | Before, from the cross-cells record |
|---|---|---|---|---|
| Opus, Terra | 0.52 / 0.94 | 0.47 / 0.89 | 33, 34 | 0.52 / 0.89, 0.51 / 0.94; 31, 33 reported |
| Sol, Terra | 0.89 / 0.94 | | 19 | 0.90 / 1.00, 0.86 / 1.00, 0.85 / 0.94; 20, 21, 20 reported |

### The writer-trust goldens

Five goldens share the `canPublish` default in `src/publish.ts` that three lenses report. Reported against expected:

| Golden | Expected | Opus pass 1 | Opus pass 2 | Sol |
|---|---|---|---|---|
| `design-fail-open-default` | 1 | 4 | 2 | 1 |
| `design-injection` | 2 | 3 | 4 | 2 |
| `design-decision-injection` | 2 | 5 | 4 | 2 |
| `design-rewrites-its-own-decision` | 1 | 3 | 3 | 1 |
| `design-supersedes-its-own-decision` | 1 | 3 | 3 | 1 |

## What the evidence shows

The sentence did not move Opus. Its precision stayed within the spread of the passes before it, and it reported as many findings as before, 33 and 34 against 31 and 33. The writer-trust goldens still drew two to five reports where one or two are expected. Sol, which already cited the breaking line, was unchanged.

Two passes of one cell cannot show a small effect, but the effect the sentence was meant to have, one report per defect on the writer-trust goldens, did not appear in either pass. The sentence was removed, and the merge by shared cause is held for a structural rule, as [the decision](../../docs/decisions/2026-10-16-merge-by-shared-cause.md) records.
