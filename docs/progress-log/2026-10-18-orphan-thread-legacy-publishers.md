# Recover legacy pending rounds without inventing publishers

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 9c, after `a2b6e1b4`.

The unchanged version-4, version-5 and version-6 publishers each wrote a pending ledger without publisher attribution.
Six SQLite cases reopen those recordings through version 9, persist them and reopen again.
With the live token identified as Bob, Alice's Bot review wins the unknown-publisher fallback over a later copy listed first.
Personal authors confer no recovery authority. Discovery makes no identity request.

The original provider from `dbeec2f4` failed the three Bot cases by missing review `1001`.
All six cases pass with the recorded-publisher rule. Type checking passes.
Fixture provenance records the historical publisher source and its current harness dependencies.
No document version changed and no stored fixture shape was built by hand.

The report contains both runs and the source digest record at `tmp/orphan-thread-pass9c-report.md`.
The final pass reruns the whole gate; its earlier process failures require the coordinator's host.
The implementation plan stays unchanged for this fix pass.
