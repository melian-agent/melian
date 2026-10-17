# Put both supersessions on declared lines

The final audit of [pull request #142](https://github.com/melian-agent/melian/pull/142) checked the new decision through DecisionFile.parse.
The second target had wrapped onto a line without Supersedes, so the parser returned only the first target.
An assertion requiring both targets failed before the correction and passes afterwards.

Each target now has its own Supersedes prefix.
Markdown soft wrapping does not continue a declaration: the parser reads physical lines.
Keep each target on a line that starts with Supersedes, or put all targets on one such line.
This changes the decision index, with no production or test-source change.
The local phase 2 report records the parser probe and the final gate and CI results.
