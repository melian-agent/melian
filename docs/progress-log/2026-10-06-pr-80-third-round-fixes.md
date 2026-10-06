# Verifier third-round fixes

[Pull request #80](https://github.com/melian-agent/melian/pull/80).

Verifier read-tool errors now use the same findings boundary and visible text as report errors. A fake-model regression reads an absent instruction-like path containing a newline. Before the fix, the model received the instruction as a raw diagnostic line. The shared read-tool error handler now quotes it.

Verification replacement now removes the adjudication owner in the same transaction that clears old judgements and repoints verification. The existing sweep aborts the parked adjudication. A rerun regression failed before the fix: the old task completed with recorded. It now ends aborted, writes no verdict, and the replacement’s refuted verdict stands.

A new ownership regression parks a spawned verifier, starts a replacement, and lets the first report after the replacement refutes its claim. The old report is refused inside its commit and the replacement’s judgement remains. Removing that ownership guard makes the test fail.

A two-claim merged candidate now has a partial-judgement regression. One claim is refuted and the other remains unjudged, so the verifier check fails, the defect stays advisory, and the review stays not reviewed. Changing the missing-verdict test from some to every makes the review succeed and the regression fail.
