# Live golden run 4, 2026-10-04

The fourth run of the golden corpus against real models, on [pull request #34](https://github.com/melian-agent/melian/pull/34), which made `report_finding` require a failure scenario and evidence locations. It is the first live run of `correctness-deleted-guard` and `pre-existing-beside-change`, and the first since commit `1c716e6` told correctness to keep only failures whose triggering input the repository supplies.

- Melian under test: `m2-evidence`. The full six-golden pass ran at `7e12c4f7d72b65897631eb2c27cbb6ab5c0950a8`; the two reruns of `contracts-breaking-signature` ran at `c06a7dff2db7e4958ad4d7a209d95cac42a4864a`. Between the two heads only how findings store and hash their snippets changed; no lens, rendered instruction, or tool result a model reads. pi-ai 1.0.0 and Pi Durable 1.0.0. Lens versions, from the loader at both heads: `correctness` `0e6c62b69941`, `contracts` `79d6ae78389c`.
- Model: `anthropic/claude-opus-5-5` for every tier, through `MELIAN_EVAL_MODEL`. Both built-in lenses are `heavy`, so this routes them as in the earlier runs, where `heavy` went to Opus 5.5.
- Credentials: an Anthropic OAuth token in `CLAUDE_CODE_OAUTH_TOKEN`, loaded with `node --env-file` on the built packages.

## Method

The reverse of the earlier order:

1. The documented runner, `packages/evals/src/live.ts`, over all six goldens at `7e12c4f`. It prints scores only.
2. `contracts-breaking-signature` alone, twice, each in its own process, through a helper like [the second run's](2026-10-03-live-goldens-2.md#method). It calls `runGolden` and `scoreGolden` from the built package with `model: "anthropic/claude-opus-5-5"`, unwraps the models handle with the pipeline's internal `modelsOf`, and rewraps it with `wrapModels` around a proxy that records each `streamSimple` request's usage, tool calls, final text, and the tool results it carried. The proxy failed to label requests by lens on the first rerun, because it did not read the system message's sections; the second labels them, and the first's lenses follow from what each conversation read and said.

Scoring matches on file and rule. Token counts are pi-ai's; `input` is uncached input. Cost is pi-ai's list-price estimate; an OAuth subscription is not billed per token.

## Results, `live.ts` at `7e12c4f`

| Golden | Expected | Reported | Precision | Recall |
| --- | --- | --- | --- | --- |
| `clean-rename` | 0 | 0 | 1.00 | 1.00 |
| `contracts-breaking-signature` | 2 | 1 | 1.00 | 0.50 |
| `correctness-deleted-guard` | 1 | 1 | 1.00 | 1.00 |
| `correctness-null-deref` | 1 | 1 | 1.00 | 1.00 |
| `injection-in-comment` | 2 | 2 | 1.00 | 1.00 |
| `pre-existing-beside-change` | 1 | 0 | 1.00 | 0.00 |
| Corpus | 7 | 5 | 1.00 | 0.71 |

The pass took 132 s for six goldens. Every finding it drew was an expected one; both misses are recall.

`pre-existing-beside-change` expects `src/receipt.ts`, `wrong-result`, `pre-existing`: a division by 10 the change did not touch. It exists to prove that a `context` location in changed code does not promote an old defect, which the scripted run proves. Both lenses tell a model to leave defects that predate the change, so a live lens that obeys never reports it. Commit `ef129d4` marks it `live: false`, and `live.ts` now skips it. Without it, this pass reads precision 1.00 and recall 0.83, 5 of 6.

## Results, `contracts-breaking-signature` alone at `c06a7df`

`contracts-breaking-signature` expects `src/cart.ts`, `broken-caller`, Critical, `affected`; and `src/price.ts`, `wrong-result`, High, `introduced`, for dividing every currency by 100 so that 500 yen renders as "JPY 5".

| Rerun | Reported | Precision | Recall | Wall clock | Requests | Tokens (output / cache read / cache write) | Cost estimate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1.00 | 0.50 | 12.4 s | 7 | 1,693 / 22,276 / 10,842 | $0.09 |
| 2 | 1 | 1.00 | 0.50 | 13.6 s | 7 | 1,750 / 25,809 / 7,074 | $0.08 |

Both reruns drew the same single finding, ID `25dec63f1d7fcd59`, and missed the same one.

| Lens | File | Rule | Severity | Cause | What | Scored |
| --- | --- | --- | --- | --- | --- | --- |
| contracts | `src/cart.ts:10` | `broken-caller` | P0 | affected | "`summary` still calls `formatPrice(total)` with one argument, but `formatPrice` now requires a second `currency: string` parameter." | matched |

The matched finding carries what the golden asks for. Its failure scenario names a call and its outcome: "`summary([{ name: "x", cents: 1234 }])` calls `formatPrice(1234)`. Type-checking fails at compile time with TS2554. Without type-checking, `Intl.NumberFormat` is built with `style: "currency"` and no currency, so every call throws". Its evidence is `src/price.ts:1-2` as `cause` and `src/cart.ts:10` as `context`, and its cause and severity agree with the golden's.

In each rerun contracts made one `report_finding` call and correctness none. Both calls were recorded first time: no refusal from the policy hook, and no rejection from `prepareArguments`.

## Why `contracts-breaking-signature` misses the yen defect

Correctness misses it, on purpose, and says why. In both reruns it read the right files: `src/price.ts` and a search for `formatPrice` in its first turn, `src/cart.ts` in its second. It then answered without calling `report_finding` at all. Rerun 1:

> I left this unfiled because a signature change that breaks its callers belongs to the contracts lens. The repository has no currency values to give me a concrete wrong-output case, such as a non-AUD or zero-decimal currency.

Rerun 2:

> Nothing in the repository passes a currency yet. So I couldn't tie the other possible problems to a real input: locale-specific symbols, such as `en-AU` showing "USD" for US dollars, or dividing by 100 for currencies like JPY that have no cents.

The lens saw the defect and applied step 3 of its method, which commit `1c716e6` added after [the third run](2026-10-03-live-goldens-3.md):

> The input must come from code or data in the repository, or from the change itself, not merely be allowed by a parameter's type. Do not report a failure that only a caller outside the repository could cause.

The golden's head passes no currency anywhere; its only caller passes none at all, which is contracts' finding. So "JPY" is an input only the parameter's type admits, and the rule drops it, as it was written to drop the third run's RangeError for a malformed code such as `"US"`.

The required fields are not the cause. The miss is the same in all three passes, so it is not model variance either. It is the reachability rule meeting a golden whose defect nothing in the repository reaches yet. I changed nothing: choosing between a lens rule and a golden's expectation is a design decision, not a fix to the required fields.

## Against run 3

Run 3 reviewed four goldens; the two new ones have no earlier score. Precision and recall from each run's `live.ts` pass, and from its helper pass where it had one.

| Golden | Precision 3, `live.ts` | Precision 4, `live.ts` | Recall 3, `live.ts` | Recall 4, `live.ts` | Recall 3, helper | Recall 4, reruns |
| --- | --- | --- | --- | --- | --- | --- |
| `clean-rename` | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | not rerun |
| `contracts-breaking-signature` | 1.00 | 1.00 | 1.00 | 0.50 | 1.00 | 0.50, 0.50 |
| `correctness-null-deref` | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | not rerun |
| `injection-in-comment` | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | not rerun |

`live.ts` corpus over run 3's four goldens: precision 1.00 and recall 1.00 in run 3; precision 1.00 and recall 0.80, 4 of 5, in run 4. Over all six in run 4: 1.00 and 0.71, or 1.00 and 0.83 without `pre-existing-beside-change`.

On `contracts-breaking-signature`, run 3's helper took 8 requests and 2,425 output tokens and drew three findings: both expected and correctness's RangeError extra. Run 4's reruns took 7 requests and about 1,700 output tokens and drew one. The reachability rule removed the extra it was written for and the yen defect with it.

## Reading

The required fields cost nothing visible. Every `report_finding` call in the reruns was accepted first time, with a failure scenario naming a concrete call and evidence in the shape the golden expects. No pass drew a finding its golden does not expect: precision is 1.00 on all six goldens, as it was on run 3's four in its `live.ts` pass.

`correctness-deleted-guard`, a pure deletion, scored 1.00 and 1.00 on its first live run. `live.ts` prints no findings, so whether the lens read the deleted guard at the base, rather than reasoning from the diff, is unrecorded.

What I would change, without tuning here:

- Decide between the reachability rule and the yen expectation, because today they contradict each other. Two ways out. Narrow the rule: an input the change sets out to accept counts as supplied by the change itself, so a change titled "Format prices in any currency" supplies `"JPY"`, an ISO code, but not `"US"`, which is no currency at all. Or keep the rule and make the golden supply the input, with a caller in the head that formats a yen price. I would narrow the rule: a reviewer that waits for the first yen caller before flagging a "format any currency" change has let the defect ship.
- Rerun `contracts-breaking-signature` three times after either change, per [the evals guideline](../../../docs/guidelines/evals.md#two-modes), and the whole corpus at least once: a narrower rule may let the RangeError extra back in.
- Record findings from `live.ts`, or run the helper over every golden, so a first live run such as `correctness-deleted-guard`'s says how the lens got there.
