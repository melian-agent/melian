# Step 9: deferred issues

`reviewChangeset` now runs deterministic checks through a review harness opened with a checkout. It keeps the loaded configuration for check identity before the plan changes model routes. Supplied records opt out, and hosts without that capability keep the existing manifest behaviour. This closes the implementation of [issue #26](https://github.com/melian-agent/melian/issues/26).

`Standards` now loads nested chains with shared reads, stable per-lens unions, and a 1 MiB cap that names whole sections omitted. Each lens now receives its own chains, and worktree sections have untrusted boundaries. Version 6 of the verdict document records per-lens paths beside their union and preserves older records with paths absent. The CLI and golden runner now load changed-path chains. Doctor lists nested carriers, their count and bytes, and warns for oversized files and skipped symlinks. This closes the implementation of [issue #46](https://github.com/melian-agent/melian/issues/46). [Issue #22](https://github.com/melian-agent/melian/issues/22) was closed by [pull request #60](https://github.com/melian-agent/melian/pull/60).

Lens task version 3 and publication document version 6 preserve older inputs and snapshots with per-lens standards absent. The three skills describe doctor's standards line. Scripted tests cover nested golden instructions; no live eval ran.

The final diff review replaced a live-task inspection assertion with the durable checks index, and added an environment-without-extension fallback test. The harness API documentation now names the wrapper needed for automatic checks. The worktree standards lead-in uses short sentences.

Final verification found that [pull request #62](https://github.com/melian-agent/melian/pull/62) had landed and the shared main ref had advanced. This branch merges that result, retaining its complete-input skip rule and the standards omission note together. The combined result passes the gate.

The first fix pass for [pull request #85](https://github.com/melian-agent/melian/pull/85) corrects the GitHub guideline: published state upgrades to version 6. The document definition confirms the target.

The manifest guideline now describes automatic checks when records are absent, matching `reviewChangeset`. Hosts can still supply records.

The standards and run-details paragraphs split the two long sentences flagged in review. Their contracts are unchanged.

Ledger standards paths now use the code renderer, per lens. The ledger regression checks the rendered code spans.

A five-section regression confirms that an imported file uses its importer's scope for omission priority. It keeps the deep root import and drops the deepest package section.

Standards imports now refuse ignored and credential files before reading. Revision imports read only tracked blobs, with ignore rules from that revision. The CLI reads range standards from commits. Core probes and a fake-model review confirm that a head's nested import cannot send clone secrets, and that the check record names the refusal. The import safety decision records this boundary.

An automatic-check regression fails a fake compiler, repairs it, confirms a repeat uses the cached failure, then verifies `rerun: true` clears it. The compiler runs once per revision on the retry.

Lens selection now fingerprints stable instruction inputs, including standards and provenance, while excluding fresh nonces. A fake-model regression reviews one revision twice after a standards edit and observes the new text in a second request. An unchanged repeat, including `rerun`, still attaches. The identity decision records the rule.

Standards now retain resolved commit provenance. The pipeline trusts only readings matching the validated policy commit, and quotes flat arrays and mismatched readings. Fake-model tests cover head standards under base policy, flat inputs and equivalent commit names. The provenance decision replaces trust by source kind.
