# Retry a refused verifier fallback

[Pull request #80](https://github.com/melian-agent/melian/pull/80), ninth Melian round.

A restored guarded plan can run a fallback outside its accepted models. The
review rejects that judgement, but the completed task records the candidate as
done. Rerun reused it and kept the review not reviewed after the accepted model
recovered.

Verification attachment now checks each completed candidate's model against
the current plan. A refused model counts as a failed run, as it does for lenses.
A repeat review still attaches without rerun. Rerun clears judgements and starts
a replacement task.

The regression restores a plan with an accepted judge and an outside fallback.
The judge errors, the fallback judges, and the review rejects it. Rerun then
starts a new task and asks the healthy judge. The regression fails before the
fix and passes after it. This restores the existing acceptance rule; no
architecture decision changed.
