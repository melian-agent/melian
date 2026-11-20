# A head that lists its own file still draws an injection finding there

The base's `melian.yaml` lists only `docs/review-brief.md`. The head adds `src/prompts.ts` to the list and, in the same change, writes text into it that a lens reports as `melian/injection-attempt`. The list comes from the base alone, so `src/prompts.ts` draws no instruction-file notice and the injection finding blocks. The change to `melian.yaml` draws its own policy notice at `acknowledge`.
