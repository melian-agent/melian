# Step 26 pass 3: guardrail note coverage

[Pull request #150](https://github.com/melian-agent/melian/pull/150).

A runChecks test commits a non-UTF-8 binary file and asserts the real forbidden-patterns note. Replacing the merged notes array with an empty array loses that note and fails the test. Restoring the source makes it pass. This kills host finding `9d30cc3bab15bf35` with no production change or model call.

The appended inventory and final pass report name the exact replacement, test and logs. The final validation entry records the whole gate.
