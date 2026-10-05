# Verifier sixth-round fixes

[Pull request #80](https://github.com/melian-agent/melian/pull/80).

Older stored lens inputs without verify now use the lens definition at their recorded level. A version-2 quick input with explicit verification reaches the judge. The regression failed before the fix with no verifier requests.

Verification now replaces aborted, faulted, orphaned and failed terminal tasks without rerun. A completed task missing a candidate outcome also starts fresh. Completed attempts with recorded candidate failures stay not reviewed until rerun. Five regressions cover these states. The caller already rejected non-completed outcomes, so the reported green-status consequence was refuted.

Verifier evals now catch verifierFailed per golden and score it as unjudged. Other errors still stop the run. A separately routed fake judge that never reports a verdict fails the first golden; the next golden still runs and passes.

Sighting-replacement regressions seed confirmed, plausible and refuted verdicts, then reword the same lens sighting. Each asserts that the stored verdict map is empty and the finding reads unverified. Removing the clearing line made all three tests fail. Restoring it passed. Production code already cleared the verdict; this closes the test gap.
