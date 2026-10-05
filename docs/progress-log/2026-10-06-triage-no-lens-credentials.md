# Reviews without lenses unlock no credentials

The sixteenth Melian round on [pull request #62](https://github.com/melian-agent/melian/pull/62) found a review with no lens checks still ran triage credential commands.

The CLI plans only lenses covering changed paths. An empty lens plan skips credential unlocking and fallback creation. The pipeline still receives all loaded lenses to account for skipped checks. Two CLI regressions use a failing command credential: one disables correctness, the other gives it unmatched paths. Both reviews pass without running the command or calling a model.
