# Live golden run, 2026-10-03

The first run of the golden corpus against real models.

- Melian under test: `adba87c39201f82197e422ecd43e8e88e37a448a`, which is `lenses` at `e2f9e91` plus the `CLAUDE_CODE_OAUTH_TOKEN` alias, with pi-ai 1.0.0. The alias landed on `lenses` as `5500ffa`, after three commits that change Pi-login expiry and budget replay but not the lens prompts or tools the models saw.
- Models, by the IDs pi-ai's catalogue uses: `anthropic/claude-sonnet-5-5` for `light` and `medium`, `anthropic/claude-opus-5-5` for `heavy`. Both built-in lenses, `correctness` and `contracts`, are `heavy`, so every request went to Opus 5.5; the Sonnet routes were configured and never called.
- Credentials: an Anthropic OAuth token in `CLAUDE_CODE_OAUTH_TOKEN`, read through the alias for `ANTHROPIC_OAUTH_TOKEN`. Pi's store held no Anthropic login.

## Method

Three passes:

1. One run per golden, through a helper that calls `runGolden` and `scoreGolden` from the built package. It routes the tiers by adding a `melian.yaml` to a temporary copy of each golden, so that file sits in both trees, and the correctness lens read it once on `clean-rename`. It wraps the model collection to record each request's usage and tool calls.
2. The same helper over the whole corpus.
3. The documented runner, `packages/evals/src/live.ts`, with `MELIAN_EVAL_MODEL=anthropic/claude-opus-5-5`. It prints scores only.

Scoring matches on file and rule. Token counts are pi-ai's: `input` is uncached input, which caching drives to two tokens a request. Cost is pi-ai's list-price estimate; an OAuth subscription is not billed per token.

## Results, one run per golden

| Golden | Expected | Reported | Matched | Missed | Extra | Precision | Recall | Wall clock | Requests | Tokens (output / cache read / cache write) | Cost estimate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `clean-rename` | 0 | 0 | 0 | 0 | 0 | 1.00 | 1.00 | 6.9 s | 5 | 809 / 9,534 / 2,982 | $0.03 |
| `contracts-breaking-signature` | 1 | 2 | 1 | 0 | 1 | 0.50 | 1.00 | 29.2 s | 10 | 2,903 / 23,127 / 5,296 | $0.09 |
| `correctness-null-deref` | 1 | 2 | 1 | 0 | 1 | 0.50 | 1.00 | 25.1 s | 10 | 2,235 / 19,057 / 6,868 | $0.08 |

Corpus, micro-averaged: precision 0.50, recall 1.00. `clean-rename` drew no findings, so its noise is zero.

### What each golden expected and got

`clean-rename` expects nothing. Both lenses searched for imports of `math.ts` and uses of `add`, found none, and answered "I reported 0 findings."

`contracts-breaking-signature` expects `src/cart.ts`, `broken-caller`, Critical, `affected`: `summary` still calls `formatPrice` with one argument.

| Lens | File | Rule | Severity | Cause | What | Scored |
| --- | --- | --- | --- | --- | --- | --- |
| contracts | `src/cart.ts:10` | `broken-caller` | P0 | affected | "`summary` still calls `formatPrice(total)` with one argument, but `formatPrice` now requires a second `currency: string` parameter." | matched |
| correctness | `src/cart.ts:10` | `unhandled-error` | P0 | affected | "`summary` still calls `formatPrice(total)` with one argument, but the change made `currency` a required second parameter." | extra |

`correctness-null-deref` expects `src/user.ts`, `null-dereference`, High, `introduced`: `managerName` reads `name` from an optional manager.

| Lens | File | Rule | Severity | Cause | What | Scored |
| --- | --- | --- | --- | --- | --- | --- |
| correctness | `src/user.ts:7-8` | `null-dereference` | P1 | introduced | "`user.manager` is optional (`manager?: User`), but the change casts it to `User` with `as User` and then reads `manager.name`." | matched |
| contracts | `src/org-chart.ts:4` | `changed-error` | P1 | affected | "`describe` passes any `User` to `managerName`, including users with no manager." | extra |

Every matched finding has the expected cause, and its severity agrees with the golden's: P0 for Critical, P1 for High.

## Results, whole corpus

| Pass | `clean-rename` | `contracts-breaking-signature` | `correctness-null-deref` | Corpus |
| --- | --- | --- | --- | --- |
| Helper, per-tier routes | 0 reported; 7.8 s; 13,346 tokens | P 0.50, R 1.00, 2 reported; 24.8 s; 32,964 tokens | P 0.50, R 1.00, 2 reported; 17.3 s; 25,964 tokens | P 0.50, R 1.00 |
| `live.ts`, Opus on every tier | 0 reported | P 0.33, R 1.00, 3 reported | P 0.50, R 1.00, 2 reported | P 0.40, R 1.00; 59 s in all |

The helper's corpus pass produced the same findings as the per-golden runs, word for word in places. One request in it failed with "Connection error." and Pi Durable's retry recovered. `live.ts` does not print findings, so its third finding on `contracts-breaking-signature` is unrecorded; it shows the extras vary from run to run.

## Reading

Recall is perfect and the clean golden is quiet. Precision is half, and every extra finding is the same defect reported a second time by the other lens. Both lens prompts need work at their shared border, and the pipeline needs one fix that is not a prompt change.

**Correctness claims the contracts lens's ground.** Its prompt tells it to report a defect "if the change provably breaks code it did not touch", which is the contracts lens's whole job. On `contracts-breaking-signature` it found the broken caller, tried to file it as `broken-caller`, was refused by the policy hook, and refiled it under the nearest rule it owns. Its own closing line says so:

> I filed it as `unhandled-error` because my first choice of rule name, `broken-caller`, isn't one of this review's rules.

What I would change: tell correctness that a caller which no longer matches a changed signature, type, or arity belongs to the contracts lens, and that a defect none of its rules fits is dropped, never refiled under another rule.

**Contracts reports a correctness bug once per caller.** On `correctness-null-deref` the change broke `managerName`'s body, and contracts reported the crash again at the caller, `describe`, under `changed-error`. Its evidence points straight at the correctness finding's lines: "src/user.ts:7-8 — `const manager = user.manager as User; return manager.name.trim();` replaced `return user.manager?.name ?? "none";`". With ten callers it would report ten findings for one bug. What I would change: tell contracts to report a dependant only when the declared contract changed, its parameters, types, return shape, or documented errors, and to leave a function whose body became wrong for some input to correctness.

That evidence also gives adjudication, step 7, a merge key: a finding whose evidence cites another finding's location shares its root cause. On `contracts-breaking-signature` the two findings share a file, line, and snippet, which is simpler still.

**The lenses never see their rule IDs.** `renderLensInstructions` renders the `LENS.md` body only, and the rules live in its front matter; `report_finding` describes `rule` as "One of the rules this lens declares". So the model guesses. In both passes, three of the four lenses that reported anything opened with a rule they do not declare: contracts invented `caller-uses-old-signature` and `dependant-uses-old-contract`, and correctness borrowed contracts' `broken-caller`. Only correctness's `null-dereference` landed first time. The hook's refusal lists the real rules and the model recovers, at a cost of one round, about 500 output tokens and four to six seconds, per lens. The fix is in the pipeline: render each lens's rules and severities into its instructions, or give `rule` an enum per lens.

**What the numbers do not show.** Three goldens with obvious seeded defects say the plumbing works on a real model and the prompts find an unsubtle bug. They say nothing about subtle defects or about noise on a large change. The next goldens should be a cross-lens case, one defect both lenses could plausibly claim, scored for single reporting, and a larger clean refactor.
