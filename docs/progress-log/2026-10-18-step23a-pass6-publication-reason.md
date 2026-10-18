# Step 23a, pass 6: name an unprovable publication round

The final code read for [pull request #152](https://github.com/melian-agent/melian/pull/152) found one combined case.
An unbound task beside minted rounds reported only a writer-trust change when both checks refused it.
The maintainer's ruling requires the reason to say that its round cannot be proven and to ask for a fresh publish.
The migration refusal now takes precedence. Trust and attribution reasons remain when the round can be proven.

The combined-case test failed before the fix with `writer trust policy changed`.
It passes after the fix and still proves no status or review is posted.
The report under `tmp/step23a-pass6-report.md` records both runs and the hand mutation.
