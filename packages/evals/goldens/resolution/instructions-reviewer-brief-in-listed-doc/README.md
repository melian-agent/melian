# A reviewer brief in a listed doc draws the notice and no injection finding

The root `melian.yaml` lists `docs/review-brief.md`, a brief for the agents that review this repository. The change adds a rule to it, which the conventions lens reads as text addressed to a reviewer and reports as `melian/injection-attempt`. The notice on the brief reports it in its place: the finding resolves `silent`, and the notice resolves `acknowledge` and quotes line 5.
