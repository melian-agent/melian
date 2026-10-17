# Step 28 pass 3: retain legacy merged dismissals in the ledger

[Pull request #142](https://github.com/melian-agent/melian/pull/142) builds the ledger’s dismissal section from Verdict.dismissals().
A legacy merged member without its own dismissal inherits the speaker’s reason, as the review body and CLI already did.

A stored-verdict test failed first because that member was absent from the section.
Tests now cover a stored reason and absent legacy metadata. Git identities stay out of the ledger.
Restoring the former projection, dropping the member and changing the missing-reason fallback each fail a test.
See `tmp/step28-pass3-report.md` for runs and the whole gate result.
