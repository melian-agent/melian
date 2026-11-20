# A guardrails record fits the store, or its check fails

Status: the maintainer ruled, on [issue #605](https://github.com/melian-agent/melian/issues/605), that a guardrails record must fit the store's 4 MiB record limit, and that one which cannot fit even with every finding's detail left out fails closed. Trimming the check's own findings, rather than only the exported record, is the builder's choice, which the coordinator agreed on 2026-11-20; it is not a ruling.

## Problem

Every record store refuses a record past core's `recordLimit`, 4 MiB. A head that changes many workspace manifests makes one guardrails finding per manifest, each naming the scripts it changes, and their record can pass the limit. The store then refused the round's records after the harness had stored a verdict of findings, so the review threw a store error with that verdict standing.

Example: 1,500 changed manifests, each naming twenty long scripts, wrote a guardrails record of about 5 MB.

## Choice

- Past the limit, the guardrails check leaves out the detail of its last findings in ID order, as `SightingBudget.checkRecord.fit` does. A trimmed finding keeps its ID, rule, severity, resolution, place and What to do, so what blocks is unchanged. Its Why here names how many files lost their detail and says that `git diff` shows them. A finding that trimming would not make smaller keeps its detail.
- A record that still passes the limit with every finding trimmed fails the guardrails check, with `RecordError` `recordTooLarge` and a fixed sentence that holds no finding's text. The review reads not reviewed, and its records export.
- Every check's record gets the same budget, not the guardrails alone. A static tool may write 16 MiB of output, so enough Biome, tsc or Enola findings could pass the limit after adjudication had stored a verdict; `runCheck` fits every check's findings where it forms the outcome. This extension is the builder's, from Codex's adversarial review; it is not a ruling.
- The trim applies to the check's own findings, not only to the exported record. The verdict's fingerprint hashes the findings' text, so trimming at export alone would give the local and the shared verdict different texts for one round.

## What it costs

A reviewer on the host also sees the trimmed detail for a very large change, though the host's own store could hold it whole. `git diff` still shows each file. A change too large to record at all gets no review until it is split.

The shared check record carries that failure's reason as `unexpected`, since `recordCodes` lists only check errors' codes, so a reader on another host does not see that the change was too large; [issue #622](https://github.com/melian-agent/melian/issues/622) would share the reason.
