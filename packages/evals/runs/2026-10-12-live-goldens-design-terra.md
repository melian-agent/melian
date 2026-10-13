# Live golden run, design lens with the Terra verifier, 2026-10-12

Three passes over the nineteen design goldens, thirteen seeded and six clean, run from `main` at 06b9907a after [pull request #102](https://github.com/melian-agent/melian/pull/102) landed. `openai-codex/gpt-6.1-sol` ran every lens tier and `openai-codex/gpt-5.6-terra` verified, one golden per invocation, from 12:35 to 13:19 with no usage-limit message. The earlier run on that pull request's branch used the Sonnet verifier and eighteen goldens.

The per-golden lines come from the run's output, kept by the coordinator. The table copies them. A cell reads reported findings, precision, recall.

| Golden | Expected | Pass 1 (reported, precision, recall) | Pass 2 | Pass 3 |
|---|---|---|---|---|
| `design-bound-on-wrong-measure` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-bound-on-wrong-measure-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-decision-injection` | 2 | 1, 1.00, 0.50 | 2, 1.00, 1.00 | 2, 1.00, 1.00 |
| `design-fail-open-default` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-identity-missing-input` | 1 | 2, 0.50, 1.00 | 2, 0.50, 1.00 | 2, 0.50, 1.00 |
| `design-injection` | 2 | 3, 0.67, 1.00 | 3, 0.67, 1.00 | 2, 1.00, 1.00 |
| `design-resumed-identity` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-resumed-identity-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-rewrites-its-own-decision` | 1 | 2, 0.50, 1.00 | 1, 1.00, 1.00 | 2, 0.50, 1.00 |
| `design-single-slot-overwrite` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-single-slot-overwrite-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-superseded-at-base-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-supersedes-its-own-decision` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-terminology-change` | 1 | 1, 0.00, 0.00 | 2, 0.50, 1.00 | 2, 0.50, 1.00 |
| `design-terminology-change-in-design` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-trust-by-label` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| `design-trust-by-label-clean` | 0 | 0, 1.00, 1.00 | 0, 1.00, 1.00 | 0, 1.00, 1.00 |
| `design-unshipped-artifact` | 1 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |

## Scoring

[The evals guideline](../../docs/guidelines/evals.md) scores a lens's goldens together as one corpus, so the counts add before they divide. The fifteen expected findings sit in the thirteen seeded goldens, and the six clean goldens reported nothing in any pass. A golden's true positives are its recall times its expected count; `design-terminology-change` in pass one reported one wrong finding, so it counts as no true positive.

| Pass | Reported | True positives | Corpus precision | Corpus recall | Mean of per-golden precision | Mean of per-golden recall |
|---|---|---|---|---|---|---|
| 1 | 17 | 13 | 0.76 | 0.87 | 0.82 | 0.88 |
| 2 | 18 | 15 | 0.83 | 1.00 | 0.90 | 1.00 |
| 3 | 18 | 15 | 0.83 | 1.00 | 0.88 | 1.00 |

The last two columns average the thirteen seeded goldens one by one, as the coordinator's notes did. Over the three passes the corpus precision averages 0.81 with a worst of 0.76, and recall averages 0.96 with a worst of 0.87. The guideline's bar is a worst precision of at least 0.8 and a worst recall of at least 0.6, so recall clears it and pass one's precision does not. The 0.60 precision of the earlier Sonnet-verifier run was a per-golden mean too, so only the per-golden columns compare with it.

Adjudicated precision was not measured. Extra sightings may be real defects or co-reports of one defect, which the earlier run's adjudication found.
