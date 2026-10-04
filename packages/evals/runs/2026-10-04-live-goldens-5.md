# Live golden run 5, 2026-10-04

The fifth run of the golden corpus against real models, after commit `cb39003` narrowed step 3 of the correctness lens. [The fourth run](2026-10-04-live-goldens-4.md) found that the rule commit `1c716e6` added, keep only failures whose triggering input the repository or the change supplies, also dropped `contracts-breaking-signature`'s yen defect in all three passes: nothing in the repository passes `"JPY"`. Step 3 now counts an input the change declares it accepts as supplied by the change, and still drops one only a parameter's type allows.

- Melian under test: `lens-input-rule` at `1ecdbd769c89ac23288e55104754788d2f709c11`, the lens change and the `MELIAN_EVAL_GOLDEN` filter on `main` after [pull request #34](https://github.com/melian-agent/melian/pull/34). The branch was then rebased onto `main`, which brought only the comparison documents of [pull request #35](https://github.com/melian-agent/melian/pull/35); the reviewed code is `76c9e76`. pi-ai 1.0.0 and Pi Durable 1.0.0. Lens versions, from the findings' `source`: `correctness` `d75574d970c4`, `contracts` `79d6ae78389c`, unchanged since run 4.
- Model: `anthropic/claude-opus-5-5` for every tier, as in run 4.
- Credentials: an Anthropic OAuth token in `CLAUDE_CODE_OAUTH_TOKEN`, loaded with `node --env-file` on the built packages.

## Method

1. `contracts-breaking-signature` alone, three times, each in its own process, through a helper like [the second run's](2026-10-03-live-goldens-2.md#method). It calls `runGolden` and `scoreGolden` from the built package with `model: "anthropic/claude-opus-5-5"`, unwraps the models handle with the pipeline's internal `modelsOf`, and rewraps it with `wrapModels` around a proxy that records each request's lens, usage, tool calls, and final text. It labels a request by the lens's opening sentence, which it finds anywhere in the request, so it does not depend on how the system message is split.
2. The documented runner, `packages/evals/src/live.ts`, over the corpus. It prints scores only.

Scoring matches on file and rule. Token counts are pi-ai's; `input` is uncached input. Cost is pi-ai's list-price estimate; an OAuth subscription is not billed per token.

The lens's new example uses time zones, not currencies: a `timeZone` parameter that formats times in any zone supplies `"Asia/Kolkata"`, and a string that names no zone is not supplied. An example about currency codes would hand this golden its answer, and the run could no longer tell a rule the model applies from one it copies.

## Results, `contracts-breaking-signature` three times

`contracts-breaking-signature` expects `src/cart.ts`, `broken-caller`, Critical, `affected`; and `src/price.ts`, `wrong-result`, High, `introduced`, for dividing every currency by 100 so that 500 yen renders as "JPY 5".

| Pass | Reported | Precision | Recall | Wall clock | Requests | Tokens (output / cache read / cache write) | Cost estimate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2 | 1.00 | 1.00 | 17.1 s | 7 | 2,564 / 22,793 / 11,736 | $0.11 |
| 2 | 2 | 1.00 | 1.00 | 18.3 s | 8 | 2,336 / 32,016 / 8,174 | $0.09 |
| 3 | 2 | 1.00 | 1.00 | 17.0 s | 7 | 2,479 / 26,318 / 7,822 | $0.09 |

Worst and mean alike: precision 1.00, recall 1.00. Every pass drew the same two findings, IDs `25dec63f1d7fcd59` and `f71efca4ec767ad3`, and nothing else.

| Lens | File | Rule | Severity | Cause | What | Scored |
| --- | --- | --- | --- | --- | --- | --- |
| contracts | `src/cart.ts:10` | `broken-caller` | P0 | affected | "`summary` still calls `formatPrice(total)` with one argument, but `formatPrice` now requires a second `currency: string` parameter." | matched |
| correctness | `src/price.ts:2` | `wrong-result` | P1 | introduced | "The function now takes any ISO currency but still divides the minor-unit amount by a fixed 100. Not every currency has 2 decimal places: JPY and KRW have 0 minor units, and KWD, BHD and OMR have 3." | matched |

The quotes are pass 1's; the other passes word both the same way in substance. Correctness's failure scenario names a declared input in every pass. Pass 2: "`formatPrice(1050, \"JPY\")`: yen has no minor unit, so 1050 is ¥1,050. The function computes 1050/100 = 10.5, and Intl rounds that to 0 fraction digits, so it returns \"JPY 11\" instead of \"JPY 1,050\"." All three also name the dinar, which the golden does not: "`formatPrice(1234, \"KWD\")` ... returns \"KWD 12.340\", ten times the real amount." That is the same defect, so it is one finding, not an extra.

Each pass made one `report_finding` call per lens, and each was recorded first time. Correctness's evidence cites `src/price.ts:1-2` as `cause` in passes 1 and 2, and `src/price.ts:2` as `cause` with line 1 as `context` in pass 3. None cites the base revision, as the golden's `context` location does; a live run does not check evidence, so the score is unaffected.

### The "US" extra

It did not return. Run 3 drew an `unhandled-error` on `src/price.ts` for a RangeError from a malformed code such as `"US"`. No pass here reported it, and no request in the three passes mentions a malformed code, a RangeError, or `"US"`. Correctness did not name it and decline it; it did not raise it at all.

### How correctness reached the defect

Its path barely changed from run 4. It read `src/price.ts` and searched for `formatPrice`, or `formatPrice|currency`, in its first turn; pass 2 also read `src/cart.ts`. Where run 4's correctness then answered with no finding, here it reported the yen defect in its next turn, and its closing line ties the input to what the change now takes. Pass 3:

> `formatPrice` now takes any currency but still divides the amount by 100. Prices come out wrong for currencies that don't use two decimal places: `formatPrice(1234, "JPY")` shows "JPY 12" instead of "JPY 1,234", and KWD amounts come out 10 times too large.

No lens sees the golden's title, "Format prices in any currency": `runGolden` commits the head as `head`. The declaration correctness read is the code itself, a new `currency` parameter passed to `Intl.NumberFormat`'s currency style. Correctness left the broken caller in `src/cart.ts` to contracts in every pass. Pass 1's closing line says "Nothing in the repository calls `formatPrice` yet", which is wrong, since `src/cart.ts` does; it cost nothing here.

## Results, `live.ts`

| Golden | Expected | Reported | Precision | Recall |
| --- | --- | --- | --- | --- |
| `clean-rename` | 0 | 0 | 1.00 | 1.00 |
| `contracts-breaking-signature` | 2 | 2 | 1.00 | 1.00 |
| `correctness-deleted-guard` | 1 | 1 | 1.00 | 1.00 |
| `correctness-null-deref` | 1 | 1 | 1.00 | 1.00 |
| `injection-in-comment` | 2 | 2 | 1.00 | 1.00 |
| `pre-existing-beside-change` | skipped, `live: false` | | | |
| Corpus | 6 | 6 | 1.00 | 1.00 |

The pass took 88 s for five goldens. Every finding it drew was an expected one, and it drew every expected one.

## Against run 4

| Golden | Precision 4, `live.ts` | Precision 5, `live.ts` | Recall 4, `live.ts` | Recall 5, `live.ts` | Recall 4, reruns | Recall 5, passes |
| --- | --- | --- | --- | --- | --- | --- |
| `clean-rename` | 1.00 | 1.00 | 1.00 | 1.00 | not rerun | not rerun |
| `contracts-breaking-signature` | 1.00 | 1.00 | 0.50 | 1.00 | 0.50, 0.50 | 1.00, 1.00, 1.00 |
| `correctness-deleted-guard` | 1.00 | 1.00 | 1.00 | 1.00 | not rerun | not rerun |
| `correctness-null-deref` | 1.00 | 1.00 | 1.00 | 1.00 | not rerun | not rerun |
| `injection-in-comment` | 1.00 | 1.00 | 1.00 | 1.00 | not rerun | not rerun |

`live.ts` corpus without `pre-existing-beside-change`: precision 1.00 and recall 0.83, 5 of 6, in run 4; 1.00 and 1.00, 6 of 6, in run 5.

On `contracts-breaking-signature`, run 4's reruns took 7 requests and about 1,700 output tokens and drew one finding. Run 5's passes took 7 or 8 requests and about 2,450 output tokens and drew two, close to run 3's 8 requests and 2,425 tokens for three. The extra output is the yen finding's `report_finding` call.

## Reading

The narrowed rule did what it was for. The yen defect, missed in all three of run 4's passes, was found in all four of run 5's, three helper passes and the `live.ts` pass. The malformed-code extra the rule was first written to drop stayed out of all four. Precision held at 1.00 on every golden.

Four passes cannot prove the extra is gone. In run 3 it appeared in the helper pass and not in the `live.ts` pass, so it comes and goes. What these passes show is that the rule no longer forces a choice between the two: the declared input is kept and the undeclared one is not raised.

What I would change, without tuning here:

- Keep the time-zone example in the lens. A golden whose defect the lens's own example describes measures nothing.
- Record findings from `live.ts`, or run the helper over every golden, as run 4 asked; this run still cannot say how correctness found `correctness-deleted-guard`'s defect.
- Give the next golden that tests this rule a declared input of another kind, so the corpus checks the rule rather than its one currency case.
