# Shadow retirement uses merged pull requests

Supersedes: 2026-10-06-shadow-reviewer-retirement.md.

The earlier record-only window could omit a difficult newer pull request whose comparison was missing. A window with no valid shadow findings also had no defined recall.

Use the ten most recent eligible merged pull requests after 2026-10-06T00:00:00Z. Every merged pull request in this repository after that instant is eligible, whether its comparison exists or not. A missing record or pending adjudication in that window blocks retirement. Require at least one adjudicated valid in-scope distinct shadow finding; zero findings leave recall undefined and keep both shadows running.

Recall must still reach 0.75. Count each distinct valid in-scope finding once across both shadows, and each pull request once across rounds. Noise, duplicates and out-of-scope findings stay outside the denominator. Fewer than ten eligible merged pull requests keep the shadows running. Missing comparisons stay absent; never reconstruct them.

The root policy still stores the window size and recall threshold. The fixed start and non-zero finding floor are part of this decision. The retirement result in melian compare stats remains a follow-up to [pull request #72](https://github.com/melian-agent/melian/pull/72).

This tightens the criterion the maintainer supplied. The fix-pass brief explicitly requests the change; the maintainer must confirm it before either shadow is retired. Neither reviewer is retired by this decision.
