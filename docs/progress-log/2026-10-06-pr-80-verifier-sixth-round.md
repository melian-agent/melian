# Verifier sixth-round fixes

[Pull request #80](https://github.com/melian-agent/melian/pull/80).

Older stored lens inputs without verify now use the lens definition at their recorded level. A version-2 quick input with explicit verification reaches the judge. The regression failed before the fix with no verifier requests.
