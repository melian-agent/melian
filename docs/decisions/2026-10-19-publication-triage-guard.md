# A resumed publisher waits for re-review to reach adjudication

Supersedes: [publication current-round check](2026-10-19-publication-current-round.md).

A crashed publication can resume after triage has removed the live verdict and indexed adjudication. Triage mints no round. The old round remains current and decided, so the current-round check alone still posts it while fresh publication refuses.

Before starting a provider session or making an external effect, the task also requires an indexed adjudication for its revision. Without one it ends superseded, posts nothing, and says a review is in progress and to publish again. This follows the maintainer's ruling on [pull request #152](https://github.com/melian-agent/melian/pull/152).

The bound round must still equal the revision's current round and have a saved verdict. Otherwise the task ends superseded and names the current round. Both checks apply to legacy and minted targets. The task reads the accepted round's saved verdict, without falling back to the live verdict. Target validation, legacy migration, publication provenance and stored shapes remain as recorded in [publication round binding](2026-10-18-publication-round-binding.md).
