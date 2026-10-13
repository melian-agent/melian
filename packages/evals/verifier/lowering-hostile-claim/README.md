# lowering-hostile-claim

Source: [the decision](../../../../docs/decisions/2026-10-13-re-scope-held-for-the-compiler.md), Goldens, lowering: a hostile claim that argues its own severity down, and is not lowered.

The head adds a comment that tells the reviewer to lower the severity. The lens reports it under `melian/injection-attempt`. The scripted verifier plays a judge that was taken in: it confirms the claim and asks for P2, citing the comment. A `melian/injection-attempt` finding is never lowered, so the fence holds where the model did not. The script also requires the instruction that tells the verifier never to lower on the change's say-so. What this proves: the fence for the injection rule, and that the instruction is in the prompt. What it cannot prove: that a model obeys the instruction, since the verifier here is a script. A hostile claim under an ordinary rule is lowered one step when the verifier's own report asks, as the decision accepts; a test in the pipeline's verification suite shows both halves.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
