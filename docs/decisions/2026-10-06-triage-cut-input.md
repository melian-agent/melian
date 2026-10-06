# Triage cannot skip from cut input

Date: 2026-10-06
Supersedes: 2026-10-05-triage-as-built.md (skip eligibility when the change prompt is cut)

The change prompt omits remaining diffs when it reaches 200 KiB.
Triage has no reading tools. It cannot judge the omitted hunks.
An author can place a defect after that limit and leave triage a harmless prefix.
A skip would then prevent the lens from reviewing the defect.

When input is cut, triage cannot skip any selected lens.
A skip answer runs at the lowest routed level in that lens's policy band.
Other answers still select a level within the band.
This rule covers every lens because a complete view is required to authorise skipping.

The decision document and task input mark the cut with `inputCut: true`.
The document retains the original distribution, including a proposed skip.
Each lens record explains that cut input disabled skipping.
The flag joins the attachment key, so decisions made before this rule cannot authorise a skip on cut input.
The field is optional; older documents remain readable.

The regression on [pull request #62](https://github.com/melian-agent/melian/pull/62) exceeds the prompt limit and supplies a skip answer.
It checks that the lens runs at its runnable floor, the cut is recorded, and a repeat review attaches without another call.
