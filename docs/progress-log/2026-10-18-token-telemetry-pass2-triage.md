# Token telemetry: triage retries and scores

[Pull request #146](https://github.com/melian-agent/melian/pull/146) now tests a failed fake lens during triage measurement. Enabling retries makes two requests instead of one and fails the test. The decider still records its choice.

Two goldens with different accuracy prove each spend line uses only that golden’s choices. Replacing the choice filter with `true` fails the test. All 32 triage tests pass after restoring both mutations. Exact replacements and logs are appended to tmp/token-telemetry-mutation-inventory.jsonl.

The host text groups another replacement under the score filter. Its individual replacement is pending export from the host’s sandbox-protected storage. The implementation plan stays unchanged.
