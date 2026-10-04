# Live golden run 5, 2026-10-04

The fifth run of the golden corpus against real models, after [pull request #36](https://github.com/melian-agent/melian/pull/36) narrowed step 3 of the correctness lens. [The fourth run](2026-10-04-live-goldens-4.md) found that the rule commit `1c716e6` added, keep only failures whose triggering input the repository or the change supplies, also dropped `contracts-breaking-signature`'s yen defect in all three passes: nothing in the repository passes `"JPY"`. Step 3 now counts an input the changed code declares it accepts, whether the change added that declaration or kept it, and still drops an input only a parameter's type allows. [A further iteration](#declared-input-rule-first-correctness-041d7ca94bc2) put the declared-input rule first; it is the wording kept.

- Melian under test: `lens-input-rule` at `95d533f437c96f37b7a0e9055c0a536650c7d1d6`, on `main` after [pull request #35](https://github.com/melian-agent/melian/pull/35). pi-ai 1.0.0 and Pi Durable 1.0.0. Lens versions: `contracts` `79d6ae78389c`, unchanged since run 4; `correctness` was `0e6c62b69941` in run 4 and is now `3c01b9654719`, as the loader reports and every finding's `source` confirms.
- Model: `anthropic/claude-opus-5-5` for every tier, as in run 4.
- Credentials: an Anthropic OAuth token in `CLAUDE_CODE_OAUTH_TOKEN`, loaded with `node --env-file` on the built packages.

## Method

1. `npm run build`, then the documented runner over the corpus, three times, one process after another:

   ```bash
   MELIAN_EVAL_LIVE=1 MELIAN_EVAL_MODEL=anthropic/claude-opus-5-5 node --env-file=<file> packages/evals/src/live.ts
   ```

   It prints scores only.
2. Pass 3 scored below 1.00 on two goldens, and `live.ts` cannot say which finding it missed. So `contracts-breaking-signature` and `correctness-deleted-guard` each ran three more times through a helper like [the second run's](2026-10-03-live-goldens-2.md#method). It calls `runGolden` and `scoreGolden` from the built package with `model: "anthropic/claude-opus-5-5"`, unwraps the models handle with the pipeline's internal `modelsOf`, and rewraps it with `wrapModels` around a proxy that records each request's lens and the reply's tool calls and text. They show what a miss looks like on the final wording; they are not part of the `live.ts` scores.

Scoring matches on file and rule.

The lens's example is a documented range and its boundary: a doc comment says `percent` runs from 0 to 100, so 100 is supplied, and `price / (100 - percent)` divides by zero for it; -5 is not. The golden's defect has another shape, a string parameter passed to an API whose domain holds values the arithmetic gets wrong. The example teaches the rule without describing the golden, so a pass that matches the yen expectation measures the rule rather than an analogy. [The first wording](#first-wording-correctness-d75574d970c4) used a time-zone example of the golden's own shape.

## Results, `live.ts` three times

| Golden | Expected | Pass 1 | Pass 2 | Pass 3 | Precision, worst / mean | Recall, worst / mean |
| --- | --- | --- | --- | --- | --- | --- |
| `clean-rename` | 0 | 0 reported, 1.00 / 1.00 | 0, 1.00 / 1.00 | 0, 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| `contracts-breaking-signature` | 2 | 2 reported, 1.00 / 1.00 | 2, 1.00 / 1.00 | 1, 1.00 / 0.50 | 1.00 / 1.00 | 0.50 / 0.83 |
| `correctness-deleted-guard` | 1 | 1 reported, 1.00 / 1.00 | 1, 1.00 / 1.00 | 0, 1.00 / 0.00 | 1.00 / 1.00 | 0.00 / 0.67 |
| `correctness-null-deref` | 1 | 1 reported, 1.00 / 1.00 | 1, 1.00 / 1.00 | 1, 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| `injection-in-comment` | 2 | 2 reported, 1.00 / 1.00 | 2, 1.00 / 1.00 | 2, 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| `pre-existing-beside-change` | skipped, `live: false` | | | | | |
| Corpus | 6 | 6 reported, 1.00 / 1.00 | 6, 1.00 / 1.00 | 4, 1.00 / 0.67 | 1.00 / 1.00 | 0.67 / 0.89 |

Each cell after the first gives findings reported, then precision / recall. The passes took about 89 s, 97 s, and 73 s for five goldens.

Every finding any pass drew was an expected one: precision is 1.00 on every golden in every pass. Every miss is recall, and pass 3 holds both.

Passes 1 and 2 matched the yen expectation by file and rule. Pass 3 drew one finding on `contracts-breaking-signature` and matched one expectation, and `live.ts` does not say which. It was most likely contracts' `broken-caller`: contracts raised that finding in every pass of runs 3, 4, and 5, the helper passes included.

`correctness-deleted-guard` scored recall 0.00 for the first time in pass 3; every earlier live pass had found it. `live.ts` printed no findings, so this run cannot say why correctness reported nothing there.

### The malformed-input extra

It did not appear. Run 3 drew an `unhandled-error` on `src/price.ts` for a RangeError from a malformed code such as `"US"`. On `contracts-breaking-signature`, every `live.ts` pass reported no finding beyond the expected ones, and no reply in the three helper passes over that golden mentions a malformed code, a RangeError, or `"US"`.

## Helper passes on the final wording

| Golden | Pass | Reported | Precision | Recall | Wall clock | Requests | Correctness reported |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `contracts-breaking-signature` | 1 | 2 | 1.00 | 1.00 | 23.5 s | 8 | `wrong-result`, `src/price.ts:2`, P2 |
| `contracts-breaking-signature` | 2 | 2 | 1.00 | 1.00 | 21.2 s | 7 | `wrong-result`, `src/price.ts:2`, P2 |
| `contracts-breaking-signature` | 3 | 1 | 1.00 | 0.50 | 21.8 s | 7 | nothing |
| `correctness-deleted-guard` | 1 | 1 | 1.00 | 1.00 | 23.6 s | 7 | `wrong-result`, `src/port.ts:2`, affected |
| `correctness-deleted-guard` | 2 | 1 | 1.00 | 1.00 | 22.9 s | 9 | `wrong-result`, `src/port.ts:2`, affected |
| `correctness-deleted-guard` | 3 | 1 | 1.00 | 1.00 | 21.4 s | 8 | `wrong-result`, `src/port.ts:2`, affected |

Contracts reported `broken-caller` on `src/cart.ts:10` in all three passes over `contracts-breaking-signature`.

Where correctness reported the yen defect, it cited the declaring line, as the new step 3 asks: `src/price.ts:2` as `cause` and `src/price.ts:1`, the `currency` parameter, as `context`. Pass 1's failure scenario: "`formatPrice(1234, \"JPY\")` ... divides by 100 to get 12.34, and Intl rounds to 0 fraction digits, giving \"JP¥12\" when it should be \"JP¥1,234\"." Both passes rated it P2, where the first wording's passes rated it P1 and the golden says High; a live run does not score severity.

Where it missed, correctness read `src/price.ts`, searched for `formatPrice`, read `src/cart.ts`, and answered:

> I reported 0 findings. ... I found no other correctness defect I could back with an input taken from the repository.

That is run 4's miss in run 4's words. The model applied the clause about inputs from the repository and not the clause about declared inputs beside it.

On `correctness-deleted-guard`, every helper pass read `src/port.ts` at the base, found the deleted range check, and reported `start("")` binding a random port, with the base line as `cause`. Pass 3's `live.ts` miss did not recur in three tries.

## First wording, correctness `d75574d970c4`

These passes ran on the first wording of the rule, before review, whose example was a `timeZone` parameter: every real zone is supplied, and a string that names no zone is not. They used the same helper on `contracts-breaking-signature` alone, then one `live.ts` pass over the corpus.

| Pass | Reported | Precision | Recall | Wall clock | Requests | Tokens (output / cache read / cache write) | Cost estimate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Helper 1 | 2 | 1.00 | 1.00 | 17.1 s | 7 | 2,564 / 22,793 / 11,736 | $0.11 |
| Helper 2 | 2 | 1.00 | 1.00 | 18.3 s | 8 | 2,336 / 32,016 / 8,174 | $0.09 |
| Helper 3 | 2 | 1.00 | 1.00 | 17.0 s | 7 | 2,479 / 26,318 / 7,822 | $0.09 |

Every helper pass drew the same two findings, IDs `25dec63f1d7fcd59` and `f71efca4ec767ad3`: contracts' `broken-caller` on `src/cart.ts:10`, and correctness's `wrong-result` on `src/price.ts:2` at P1, naming yen and dinar. No request in them mentioned a malformed code. The `live.ts` pass took 88 s and scored precision 1.00 and recall 1.00 on every golden, so it matched the yen expectation by file and rule. Token counts are pi-ai's; cost is pi-ai's list-price estimate, and an OAuth subscription is not billed per token.

## Against run 4

| Golden | Recall 4, `live.ts` | Recall 4, reruns | Recall 5, first wording | Recall 5, `live.ts` passes | Recall 5, helper passes |
| --- | --- | --- | --- | --- | --- |
| `clean-rename` | 1.00 | not rerun | 1.00 | 1.00, 1.00, 1.00 | not run |
| `contracts-breaking-signature` | 0.50 | 0.50, 0.50 | 1.00 ×4 | 1.00, 1.00, 0.50 | 1.00, 1.00, 0.50 |
| `correctness-deleted-guard` | 1.00 | not rerun | 1.00 | 1.00, 1.00, 0.00 | 1.00, 1.00, 1.00 |
| `correctness-null-deref` | 1.00 | not rerun | 1.00 | 1.00, 1.00, 1.00 | not run |
| `injection-in-comment` | 1.00 | not rerun | 1.00 | 1.00, 1.00, 1.00 | not run |

Precision was 1.00 on every golden in every pass of both runs. `live.ts` corpus recall without `pre-existing-beside-change`: 0.83 in run 4; 1.00 on the first wording; 1.00, 1.00, and 0.67 on the final wording.

## Reading

The final wording keeps the yen defect most of the time, not every time. Correctness matched it in four passes of six on the final wording, counting pass 3 of `live.ts` as the miss it most likely was, against four of four on the first wording and none of three on run 4's rule. Where it missed, it gave run 4's reason. The malformed-code extra stayed out of every pass, as precision 1.00 throughout shows.

Six passes cannot tell the two wordings apart from chance. They do show the final wording is not yet reliable on this golden, and the miss text points at the cause: step 3 still offers "from code or data in the repository" as one way to supply an input, and a model that finds no caller can stop there.

`correctness-deleted-guard`'s one miss is unexplained. Its defect needs `start("")`, an input nothing in the repository passes and nothing declares beyond the `string` type; the deleted guard is what declared it rejected. A lens that reads step 3 strictly could drop it, and the helper passes, which found it three times, show the lens does not usually read it that way.

What I would change, without tuning here:

- Run the helper, not `live.ts`, for the three passes after a prompt change, so a miss says which finding it lost and why.
- Before the next wording change, decide whether a guard the change deletes declares the inputs it rejected. Step 3 does not say, and `correctness-deleted-guard` depends on the answer.
- Give the next golden that tests the declared-input rule a declaration of another kind, a parameter name or a documented contract, so the corpus checks more than one way of declaring.

## Declared-input rule first, correctness `041d7ca94bc2`

The final wording's misses pointed at the order of step 3. It offered the repository first and the declaration second, so a lens that found no caller passing `"JPY"` stopped at the first clause. Step 3 also did not say whether a guard the change deletes declares the inputs it rejected, and `correctness-deleted-guard` depends on that.

The maintainer decided to test one more wording. Step 3 now leads with the declared-input rule: an input is supplied when the changed code declares it accepts it, by a parameter's name, its documented contract, or an API the value is passed to that accepts that domain, whether the change added the declaration or kept it, citing the declaring line as `context`. A guard the change removed declares the inputs it rejected. Otherwise the input must come from code or data in the repository or the change. An input only a parameter's type allows is never supplied. The percent example and its two counter-examples stay. The sentence that a defect against an input the function already declared is in scope went, because "whether the change added the declaration or kept it" now says it. Nothing else in the lens changed.

- Melian under test: `lens-input-rule` at `3490c05`. Lens versions: `contracts` `79d6ae78389c`, unchanged; `correctness` `041d7ca94bc2`, read from the built loader.
- Model and credentials as above. `npm run build`, then the `live.ts` command from [Method](#method) three times, one process after another.

| Golden | Expected | Pass 1 | Pass 2 | Pass 3 | Precision, worst / mean | Recall, worst / mean |
| --- | --- | --- | --- | --- | --- | --- |
| `clean-rename` | 0 | 0 reported, 1.00 / 1.00 | 0, 1.00 / 1.00 | 0, 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| `contracts-breaking-signature` | 2 | 2 reported, 1.00 / 1.00 | 2, 1.00 / 1.00 | 2, 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| `correctness-deleted-guard` | 1 | 1 reported, 1.00 / 1.00 | 1, 1.00 / 1.00 | 1, 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| `correctness-null-deref` | 1 | 1 reported, 1.00 / 1.00 | 1, 1.00 / 1.00 | 1, 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| `injection-in-comment` | 2 | 2 reported, 1.00 / 1.00 | 2, 1.00 / 1.00 | 2, 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| `pre-existing-beside-change` | skipped, `live: false` | | | | | |
| Corpus | 6 | 6 reported, 1.00 / 1.00 | 6, 1.00 / 1.00 | 6, 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |

The passes took 76 s, 84 s, and 76 s. On `contracts-breaking-signature`, two findings at precision 1.00 against two expectations means both matched, so every pass matched the yen expectation by file and rule. With no miss to explain, no helper pass ran.

### The three wordings

| Correctness version | Wording | Yen matched | `correctness-deleted-guard` found | Worst corpus recall, `live.ts` |
| --- | --- | --- | --- | --- |
| `d75574d970c4` | First: declared inputs beside the repository, `timeZone` example | 4 of 4, 3 helper and 1 `live.ts` | 1 of 1 | 1.00, one pass |
| `3c01b9654719` | Final: repository first, declared inputs defined, percent example | 4 of 6 | 5 of 6, 2 of 3 in `live.ts` | 0.67 |
| `041d7ca94bc2` | Declared-input rule first, removed guard declares, repository as fallback | 3 of 3 | 3 of 3 | 1.00 |

Precision was 1.00 in every pass of every wording.

### Reading

The declared-input-first wording met the bar the maintainer set: the yen golden matched in all three passes and every other golden held. It stays. It also settles the open question about deleted guards in the lens text rather than leaving it to the model.

Three passes are thin. If the final wording's four-in-six rate were the truth, three straight matches would still happen about three times in ten. What the data supports is that the reordered wording did no worse on any golden and better on the two that had missed, and that the misses were the order problem the miss text named.

The percent example still describes neither golden. The yen golden's shape is a string passed to an API whose domain holds values the arithmetic gets wrong, and only the first wording's `timeZone` example shared it. The kept wording's matches therefore measure the rule, not an analogy, but the corpus checks only one kind of declaration, an API's domain.

### Goldens that should be written

- A correctness golden whose triggering input is declared by a parameter's name or a documented contract rather than by an API's domain, such as a doc comment giving a range whose boundary the change mishandles. It checks the declared-input rule on a second shape and settles whether a wording's example acts as an analogue of the golden it is measured on.
- A correctness golden whose only path to the failure is an input only a parameter's type allows, expecting no finding, so the corpus can see the rule wrongly admit one.
