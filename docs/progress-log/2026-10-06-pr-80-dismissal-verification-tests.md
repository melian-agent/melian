# Dismissed-only verification checks

[Pull request #80](https://github.com/melian-agent/melian/pull/80) updates dismissal regressions for the empty-candidate rule. A later review retains each dismissal and its stored judgement, drops the verifier check, and spends no more model requests. Its first adjudication reflects the changed manifest; repeat reviews attach to that result. CLI JSON and output agree after the check leaves.
