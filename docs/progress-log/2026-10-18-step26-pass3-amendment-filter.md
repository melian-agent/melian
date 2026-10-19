# Step 26 pass 3: amendment filter coverage

[Pull request #150](https://github.com/melian-agent/melian/pull/150).

A mixed Supersedes/Amends unit test proves that whole retirement does not enter amendment targets. It kills the host survivors `fbbc9fb00fc63812` and `2ef057cb03405b4c`, plus all four other installed instrumenter mutants on those lines. Each exact replacement ran alone. The source was restored and the decision-files test file passed. Production behaviour is unchanged.

The inventory and per-mutant logs are under `tmp/step26-pass3-*`; the existing inventory has the appended results. The final pass report records the whole gate.
