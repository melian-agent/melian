# Comparison refuses an interrupted dismissal’s old verdict

For [pull request #68](https://github.com/melian-agent/melian/pull/68), round eighteen’s `e11a531383c98a46` is confirmed. A SQLite regression runs a real dismissal, interrupts it after the lifecycle and replacement task commit, and reopens through the comparison harness. The baseline accepts the old verdict and writes a comparison.

Comparison now checks the adjudication owner, terminal result and findings version within its write commit, as publication checks them before posting. The preflight applies the same rule. Imports, hand matches and unmatches refuse without changing the comparison. No pending task resumes and no model is called. Completing the same dismissal adjudication restores comparison and renders the dismissed label.

Unit regressions also cover changed findings with no indexed task and a missing indexed task. The metadata preservation fixture now supplies the findings version its decision records. The design and pipeline guideline record the freshness rule. The decision preserves compatibility with verdicts stored before decision records.
