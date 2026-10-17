# Step 28 pass 3: distinguish Git’s blob and diagnostic streams

[Pull request #142](https://github.com/melian-agent/melian/pull/142) tightens the policy-blob tests.
The success test compares the trigger with Git’s real blob ID while stderr carries a distinct diagnostic.
The refusal test supplies different stdout and stderr and checks that the error quotes stderr.
Both fakes assert the complete blob query.

The exact host survivors, blob.stdout changed to blob.stderr and blob.stderr changed to blob.stdout, each fail their corresponding test.
Production code stays as written. The restored guardrails suite passes.
Run details are in `tmp/step28-pass3-report.md`.
