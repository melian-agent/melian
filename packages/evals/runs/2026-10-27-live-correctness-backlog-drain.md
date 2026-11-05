# Live golden run, correctness backlog drain, 2026-10-27

Two owed goldens joined the `correctness` corpus: `correctness-duplicate-variant-key`, from finding C3 of the [comparison record](../comparisons/2026-10-05-pr-62.md) for [pull request #62](https://github.com/melian-agent/melian/pull/62), and `correctness-platform-path-separator`, from finding 8 of the [comparison record](../comparisons/2026-10-03-pr-11.md) for [pull request #11](https://github.com/melian-agent/melian/pull/11). [The drain rule](../../../docs/guidelines/evals.md#the-drain-rule) requires a live run of three passes over the lens they belong to. This record covers that measurement.

## Setup

- **Head.** `d6963c4368c10e35bb4f3c8c94b43ac081faf748`, the commit that adds the two goldens. Node v24.19.0. The run was complete: three passes, no failed golden, no unavailable usage. The commit that adds this record changes documentation only. Source, fixtures and lens bytes are those measured.
- **Corpus.** The seven goldens whose names start with `correctness-`, all live: `correctness-deleted-guard`, `correctness-deleted-rethrow`, `correctness-duplicate-variant-key`, `correctness-null-deref`, `correctness-platform-path-separator`, `correctness-refuses-unrecognised-input-clean` and `correctness-repeated-shape`. Seven goldens, three passes: 21 golden runs. A golden scores the whole review, so every lens's findings count.
- **Models requested.** Finder `anthropic/claude-opus-5-5` through `MELIAN_EVAL_MODEL`, verifier `anthropic/claude-sonnet-5-5` through `MELIAN_EVAL_VERIFIER_MODEL`, and `MELIAN_EVAL_THINKING="heavy=low"`.
- **Runner.** A scratch script outside the repository called `loadGoldens`, `runGolden` with `kind: "live"`, `reportGoldens` and `scoreCorpus` directly, with `MELIAN_EVAL_SHOW=1`, and wrote each run's findings, rendering and detached telemetry to JSON. It changed no lens, prompt, fixture or score rule. The raw files stay with the coordinator and are not committed.
- **No lens retuning.** Nothing was changed after a pass to improve a score.

## Reasoning levels: requested against observed

The telemetry holds 330 requests, all with source `observed`. Every one sent `output_config.effort: "high"` and an adaptive `thinking` block. The levels asked for and the levels the provider reported differ:

| Model | Stage | Requested | Provider-reported | Sent effort | Requests |
|---|---|---|---|---|---|
| `anthropic/claude-opus-5-5` | `melian.lens`, every lens but `design` | low | low | high | 227 |
| `anthropic/claude-opus-5-5` | `melian.lens`, `design` | off | high | high | 9 |
| `anthropic/claude-sonnet-5-5` | `melian.verification.candidate` | off | high | high | 94 |

The provider-reported level is the authority, as [the reasoning-levels run](2026-10-19-reasoning-levels.md#limits) found for Anthropic's managed-effort models: the opening body carries `high` whatever was asked, and the provider says what it applied. So the 227 heavy-tier Opus requests ran at low, and `heavy=low` did what it was meant to do. The other 103 requests did not run at low.

The nine Opus requests at off served one stage only: the `design` lens (`design@8a2249b0f9e0@careful`) on `correctness-refuses-unrecognised-input-clean`, three requests in each pass. That golden's `melian.golden.yaml` names Melian's `full` tier, which includes `lens.design`, and no other correctness golden runs `design`. The lens file declares `tier: medium` (`.melian/lenses/design/LENS.md`, line 4). The override named `heavy` alone, so `medium` carried no requested level, and the provider reported `high` for it. The Sonnet verifier also requested off and reported `high`. It ran nine verification stages a pass, covering 12, 13 and 12 candidate reports across passes 1, 2 and 3. Each pass retained nine reported findings; the clean golden had none. Verification took 94 requests over the three passes.

I read the requested, reported and sent levels from the telemetry. Why the provider reports `high` for a request that asked for off is not in the telemetry, so this record does not say.

## Lens versions

Two sets of lens versions ran, and each is stable across the three passes. The five goldens with no `melian.golden.yaml` ran one set. The two goldens with a `melian.golden.yaml` that names Melian's `full` tier, `correctness-deleted-rethrow` and `correctness-refuses-unrecognised-input-clean`, ran the other. The guideline says that a golden naming Melian's tier gets the checkout's `.melian/lenses/*/LENS.md` written into its built trees, so I read the second set as the repository-extension variants and the first as the built-in lenses. I compared hashes only, not lens bytes.

| Lens | Five goldens with no policy | Two goldens with Melian's tier |
|---|---|---|
| `contracts` | `dd8fb36095b4` | `43fa057f7957` (clean golden only) |
| `conventions` | `1815e2aee9b9` | `ab9fda3d360c` (clean golden only) |
| `correctness` | `18c49f913df8` | `ac390a655d0e` (both) |
| `removed-behaviour` | `37aeab0038e3` | `8e3474a4b315` (clean golden only) |
| `tests` | `9eb5dbf32a98` | `e6364f9cf7e6` (clean golden only) |
| `trust-boundary` | `24aa8e2540b4` | `e21a19e886b1` (clean golden only) |
| `design` | not run | `8a2249b0f9e0` (clean golden only) |

Every version ran at `careful`. `correctness-deleted-rethrow` runs under the `standard` tier, so only `correctness` ran there. The `durability` lens is in the clean golden's tier and recorded no stage.

## Scores

Counts, per golden. All three passes returned the same counts for every golden, so each golden's worst and mean precision and recall equal the values shown. "Found" is the number of expected findings the review found; "TP" is the number of reported findings that matched one.

| Golden | Expected | Reported | TP | Found | Precision | Recall |
|---|---|---|---|---|---|---|
| `correctness-deleted-guard` | 2 | 2 | 1 | 2 | 0.50 | 1.00 |
| `correctness-deleted-rethrow` | 1 | 1 | 1 | 1 | 1.00 | 1.00 |
| `correctness-duplicate-variant-key` | 1 | 1 | 1 | 1 | 1.00 | 1.00 |
| `correctness-null-deref` | 1 | 1 | 1 | 1 | 1.00 | 1.00 |
| `correctness-platform-path-separator` | 1 | 1 | 1 | 1 | 1.00 | 1.00 |
| `correctness-refuses-unrecognised-input-clean` | 0 | 0 | 0 | 0 | 1.00 | 1.00 |
| `correctness-repeated-shape` | 3 | 3 | 3 | 3 | 1.00 | 1.00 |

The pooled score is `scoreCorpus`'s: counts summed across the seven goldens, then divided. I summed the per-golden counts; the stored pass records hold only the two ratios, which agree with the sums.

| Pass | Reported | TP | Expected | Found | Precision | Recall |
|---|---|---|---|---|---|---|
| 1 | 9 | 8 | 9 | 9 | 8/9 = 0.8889 | 1.00 |
| 2 | 9 | 8 | 9 | 9 | 8/9 = 0.8889 | 1.00 |
| 3 | 9 | 8 | 9 | 9 | 8/9 = 0.8889 | 1.00 |
| Worst | | | | | 0.8889 | 1.00 |
| Mean | | | | | 0.8889 | 1.00 |

The bar in [the evals guideline](../../../docs/guidelines/evals.md#two-modes) is corpus precision of at least 0.8 and recall of at least 0.6 over three passes. The corpus meets both. The pass score is the pooled one; I did not average per-golden scores to reach it. A golden may ship below the bar if a record says so, and none needed that here.

## Misses and extras

**Misses: none.** Every expected finding was found in every pass.

**Extras: one a pass, the same one each time.** `correctness-deleted-guard` reports two findings and scores precision 0.50 in all three passes:

- A merged finding on `src/port.ts` at line 2, severity P1, `affected`, confirmed. Its claims are `removed-behaviour`'s `dropped-guard` and `correctness`'s `wrong-result`. The two expected claims of the golden are exactly these, so this one finding satisfies both: found 2. In passes 1 and 3 `lens.removed-behaviour` spoke the finding and `lens.correctness` supplied the other claim; in pass 2 the roles swapped. It counts once as a true positive.
- An extra on `src/server.ts` at line 5: rule `changed-error`, `lens.contracts`, P1, `affected`, confirmed by the verifier. The golden expects nothing on `src/server.ts`, and the finding's rule is not one the golden expects. It costs precision once. Hence reported 2, TP 1, found 2.

The mechanism is the `contracts` lens reading `start` in `src/server.ts` as a caller that relied on `parsePort` throwing `invalid port`, with the deleted throw as the changed error. It describes the same root cause as the expected finding, seen from the caller. Scoring matches by file and rule, so the caller report does not match the expected finding on `src/port.ts`. In pass 1 the verifier said the claim "overstates two cases": from memory of Node it expected `listen` to reject NaN and 70000 with `ERR_SOCKET_BAD_PORT`, a different error rather than none. It confirmed the `""` to 0 case it had traced. Passes 2 and 3 made the same point in their reasons. Whether this finding is valid, a duplicate or noise is the maintainer's adjudication; this record does not make it, and I changed no fixture or expectation.

**The new goldens drew no miss and no extra.**

- `correctness-platform-path-separator`: `lens.correctness` spoke `wrong-result` on `src/paths.ts` at line 5 in all three passes. `lens.removed-behaviour` added a `dropped-guard` claim to the same finding each time, which does not cost precision.
- `correctness-duplicate-variant-key`: `wrong-result` on `src/bands.ts` at line 10, one finding in each pass. In passes 1 and 2 `lens.correctness` spoke it. In pass 3 `lens.removed-behaviour` spoke it as `dropped-guard`, and `lens.correctness`'s `wrong-result` is its other claim, so the golden's expected `wrong-result` from `lens.correctness` matches it. That is neither a miss nor an extra. Pass 1 added a `removed-behaviour` `dropped-guard` claim. Pass 2's raw claims list a second `wrong-result` from `lens.correctness` and a `removed-behaviour` `moved-code-lost-anchor`, all confirmed; they merged into the one finding.

The other four goldens matched their expectations: `correctness-null-deref` gave `null-dereference` on `src/user.ts`; `correctness-deleted-rethrow` gave `unhandled-error` on `src/migrate.ts` from `correctness` alone; `correctness-repeated-shape` gave three `wrong-result` findings, one each on `src/errors.ts`, `src/messages.ts` and `src/warnings.ts`; and the clean golden drew nothing from any lens, including `design` with provider-reported high effort.

## Usage

From the detached telemetry of each run, as [Measurement cost](../../../docs/guidelines/evals.md#measurement-cost) requires. No run reported unavailable usage.

| Pass | Input | Output | Cache read | Cache write | Total tokens | Requests | USD |
|---|---|---|---|---|---|---|---|
| 1 | 308 | 22,567 | 400,266 | 194,214 | 617,355 | 107 | 1.3350917 |
| 2 | 314 | 23,043 | 434,332 | 176,504 | 634,193 | 110 | 1.2765999 |
| 3 | 320 | 23,736 | 450,064 | 177,970 | 652,090 | 113 | 1.2771923 |
| All | 942 | 69,346 | 1,284,662 | 548,688 | 1,903,638 | 330 | 3.8888839 |

By model over the three passes: `anthropic/claude-opus-5-5` took 236 requests, 1,425,929 tokens and 3.3157062 USD; `anthropic/claude-sonnet-5-5` took 94 requests, 477,709 tokens and 0.5731777 USD.

Each golden, per pass: total tokens, USD, requests.

| Golden | Pass 1 | Pass 2 | Pass 3 |
|---|---|---|---|
| `correctness-deleted-guard` | 125,671; 0.3069920; 22 | 131,341; 0.2438878; 23 | 130,346; 0.2361166; 23 |
| `correctness-deleted-rethrow` | 32,911; 0.0584110; 6 | 31,264; 0.0507149; 6 | 31,644; 0.0543379; 6 |
| `correctness-duplicate-variant-key` | 93,804; 0.1909687; 16 | 92,542; 0.1882118; 16 | 105,864; 0.2003300; 18 |
| `correctness-null-deref` | 74,846; 0.1532502; 14 | 74,470; 0.1523618; 14 | 74,670; 0.1542225; 14 |
| `correctness-platform-path-separator` | 90,448; 0.1801960; 16 | 98,000; 0.1813170; 17 | 102,614; 0.1856965; 18 |
| `correctness-refuses-unrecognised-input-clean` | 92,815; 0.2257492; 13 | 87,284; 0.2271794; 12 | 92,939; 0.2182662; 13 |
| `correctness-repeated-shape` | 106,860; 0.2195246; 20 | 119,292; 0.2329272; 22 | 114,013; 0.2282226; 21 |

## Limits

- One finder and verifier pair. The earlier [Opus low cell](2026-10-19-reasoning-levels.md) scored five `correctness` goldens against the Terra verifier. This corpus has seven goldens and the Sonnet verifier, so the two are not a controlled comparison.
- Three passes of one stochastic model. Seven goldens hold nine expected findings.
- The levels in the first table come from telemetry on every request. The reason the provider reports `high` where `off` was asked is not recorded.
- The two lens-version sets are labelled from the guideline's rule and from which goldens ran them. I did not compare the lens bytes.
- This record covers the live measurement alone. The full gate, Codex's adversarial review, Melian's own round, the Claude review of record and CI are the coordinator's, and are pending for the final head of this branch. The comparison records for these goldens' source pull requests are unchanged.
