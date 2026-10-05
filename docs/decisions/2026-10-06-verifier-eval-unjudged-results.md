# Score unfinished verifier evals

Supersedes: 2026-10-05-verifier-as-built.md, unfinished eval handling only.

Problem: an unfinished judge threw verifierFailed and stopped the whole verifier corpus.

Example: a judge answered without report_verdict on the first golden. The remaining five goldens never ran.

Choice: catch verifierFailed for each golden, retain its not-reviewed rendering and score it as unjudged. Continue to the next golden. Other errors still stop the run.

Why: a missing judgement is a measured failure, not a reason to lose the rest of the corpus.
