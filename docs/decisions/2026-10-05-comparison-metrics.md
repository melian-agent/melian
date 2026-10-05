# Counting adjudicated comparisons

Choice: Recall counts distinct valid groups at each compared revision. A reviewer gets credit only for its own report judged valid. Precision counts valid reports over valid, noise, and duplicate reports. An unadjudicated report is pending and enters neither metric. An ambiguous site pairing waits outside recall matching; its explicit judgement still enters precision. An external-only group whose valid reports all say `out-of-scope` stays outside Melian's recall denominator. An empty denominator gives 1, with the raw counts beside it. Reviewers aggregate by name and case-folded login, ignoring version.

`--since` and `--last` select whole changesets by their first comparison time. Earlier rounds stay in their statistics. Repeat candidates need two changesets, so two rounds of one change never qualify. Debt takes the latest judgement per changeset and finding. Withdrawing a finding leaves its history stored but removes it from that round's summaries.

A group with conflicting miss reasons uses the first in-scope reason in site order, falling back to `out-of-scope`. Each defect contributes one miss. Titles that normalise to no letters or digits do not form repeat clusters.

The drain counts each changeset once. At three or more comparisons, remaining debt keeps the drain due, including after a missed threshold. Local state cannot prove which backlog pull requests shipped or which live runs passed. The maintainer acknowledges discharged debt through another adjudication with `--golden none`. The CLI does not claim that acknowledgement verifies a shipped golden. An empty debt list owes no drain.

Why: A comparison can hold two reviewers at one defect, and several rounds at one changeset. Example: both reviewers report one null dereference; counting their reports as two defects halves another reviewer's recall. Counting three rounds as three comparison records also calls for a drain on one change. Groups settle the first count; changeset identity settles the second. Explicit judgements keep pending findings from becoming assumed truth.

The comparison adjudication class is named `Adjudication` in its module and exported as `ComparisonAdjudication`. Core already exports the review's `Adjudication`; the alias keeps both APIs clear. Optional `adjudications`, `createdAt`, and `target` fields extend version 1 without a migration. Export uses one round per stored revision. The Fix commit column stays "Not recorded", since the specified adjudication has no field for one.

Supersedes: no decision file. It defines the arithmetic and local drain notice left open by [2026-10-05-comparison-as-a-capability.md](2026-10-05-comparison-as-a-capability.md).
