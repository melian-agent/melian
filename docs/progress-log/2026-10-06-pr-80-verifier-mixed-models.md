# Check every verifier candidate’s model

[Pull request #80](https://github.com/melian-agent/melian/pull/80), eleventh Melian round.

The guarded acceptance check read only the first completed candidate’s model.
An accepted judge finished one candidate before another failed over to a
rejected backup. The review counted verification as run.

The check now inspects every completed model. Any rejected model supplies the
failed verifier check’s lineage and existing refusal reason. Adjudication
records not reviewed, and the caller receives verifierFailed. This restores
the existing acceptance rule; no architecture decision changed.

The fake-model regression reports two distinct candidates. The judge confirms
one and errors on the other, which the backup confirms. It asserts completed
results in accepted-then-rejected order, each candidate’s request models, the
refusal, the rejected lineage and the stored not-reviewed verdict. The old
code fails because the review succeeds. The fixed code passes.
