# Triage clears a superseded verdict

A replacement triage removed the adjudication pointer but kept its stored verdict. After a crash, findings displayed that verdict. Publication accepted it while its findings version still matched.

The pending decision's commit now clears the revision's verdict, provenance, and decision beside the index change. Readers see no review until replacement adjudication writes a new one. Finished lens tasks stay attachable.

The SQLite regression completes a review, starts replacement triage, and kills the process after its decision commit. It reopens storage, checks findings and publication refuse the old verdict, then completes the review and checks both readers again.

Supersedes: 2026-10-06-triage-waits-before-adjudication.md, for stored verdicts during replacement triage.
