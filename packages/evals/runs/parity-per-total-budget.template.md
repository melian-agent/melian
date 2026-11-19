# Parity per total budget, <date>

<!-- Copy this file to <date>-parity-per-total-budget.md and fill each placeholder. Delete these comments. -->

Every earlier measurement ran the design lens with its graph tools refusing, because none opened Enola's graph, so every earlier figure understated that lens. This run opens the graph for both arms, as the CLI does. It asks whether Melian finds a review of record's misses when its lenses together spend what a committed round spends, for [issue #561](https://github.com/melian-agent/melian/issues/561), under [the method](../../../docs/guidelines/evals.md#measuring-parity-per-total-budget).

## What the token figures count

- A round's spend line sums every response's input, output, cache reads and cache writes.
- A lens budget leaves out cache reads, counting input, cache writes and output. Each parity share uses this count, because it is what a lens's budget meters; a share in the Spend count would let cache reads, about 80% of a lens's tokens, decide where a lens stops. The results file records both counts for every attempt and stage, as `tokens` and `budgetTokens`.
- Codex's "tokens used" is input less cached input, plus output.
- The Agent tool's figure for a review of record was unverified before this measurement, and is now known not to be a sum.
- Every parity lens runs at `high` thinking, so part of each share goes on reasoning.
- The parity total is what the committed arm's lens conversations spent by the budget count, a probing lens's planner included. Its probers, triage, verification and walkthrough are left out of it; the run prints each one's spend beside the total after every review, and the results table gives them below.

Melian's yardstick is [the review of record on pull request #552](https://github.com/melian-agent/melian/pull/552#issuecomment-6965864283): 52 tool uses in 23 minutes, about 8.03 million tokens summed from its transcript with cache reads, beside Codex's 114,858 printed tokens, about 1.6 million with cache reads. These are the Spend kind, so compare them with the Spend columns below, not the budget count.

## Setup

- **Commit.** `<the results file's commit>`. Node `<version>`. The checkout held no uncommitted change.
- **Policy commit.** `<the results file's policyCommit>`, whose policy, standards and lenses reviewed every miss in both arms. `<n> of <m>` misses could be scored under it, by the dry run; the refused ones and the check each failed: `<list>`.
- **Misses.** `<names>`, from `<misses file>`, each with hand-entered `lines`.
- **Models.** `<each tier's first model>`, verifier `<model>`, on `<subscription logins>`. Every route was held to its first model.
- **Stops.** Review stop `<tokens>`, run stop `<tokens>`, both with cache reads.
- **Outcome.** `<complete, or stopped and why, from the results file's stopped field>`.

## Results

| Miss | Committed arm | Spend (cache reads) | Budget count | Parity total | Parity arm | Spend (cache reads) | Budget count |
|---|---|---|---|---|---|---|---|
| `<miss>` | `<found by …, or missed, or unscored>` | `<tokens> (<cache reads>)` | `<budgetTokens>` | `<total>` | `<said>` | `<tokens> (<cache reads>)` | `<budgetTokens>` |

The committed arm's whole review by the budget count, from the line the run printed after it:

| Miss | Lenses (the parity total) | Probers | Triage | Verification | Walkthrough |
|---|---|---|---|---|---|
| `<miss>` | `<lenses>` | `<probers>` | `<triage>` | `<verification>` | `<walkthrough>` |

Run totals over every attempt, stopped ones included: `<tokens>` Spend, `<budgetTokens>` by the budget count. Stopped attempts: `<miss, arm and stopped reason for each, or none>`.

## Lenses their share ended

<!-- For each parity lens with ended: count, from the results file. -->

| Miss | Lens | Share | Unread covered files | Open attacks |
|---|---|---|---|---|
| `<miss>` | `<lens>` | `<tokens>` | `<files>` | `<attack ids, prober only>` |

## What the result says

<!-- Problem, example, conclusion: where the parity arm found what the committed arm missed, or not, and what that says about budget against capability. A miss one arm found and the other missed can be read turn by turn in its store, which stays on the host. -->

## Limits

- Today's standards judged old code, so a finding outside a miss's lines says little about how that code was reviewed.
- The stores, which hold the head's code and the models' words, stay on the host and are not committed.
- The run counts only what each review's telemetry recorded. A review the run ended during counts what its store recorded by then, and a turn the process died in the middle of may be missing from it.
- `<anything else: a stop, a model answering at a level other than requested, a miss unscored>`
