# Version-1 comparisons across the rounds rollout

These SQLite files were written by the code each directory names, using that tree’s own locked dependencies. No stored field was assembled by hand.

- `main-36122eb2/comparisons.sqlite` holds two revision comparisons, each with an external finding and a replacement adjudication history. That code predates rounds.
- `build1-0ee97219/comparisons.sqlite` holds two minted rounds at one revision. Its version-1 comparison was first written after the second round decided. It cannot be assigned to either round.

`recorded.json` names each source commit, revision and external finding. The capture runs `reviewChangeset`, `CompareHarness.importFindings` and `CompareHarness.adjudicate` with fake models. It closes storage before copying or reopening it.

To reproduce, extract `git archive <commit>` to an isolated source directory, install that tree’s locked dependencies, and copy `capture.mjs` to its root. Run Node 24 with `--conditions=@melian-agent/source`, followed by the script path, an absolute output directory and the commit. Add `minted` for the build-1 capture. The script imports only the historical tree. Tests copy the SQLite files to temporary directories before writing.
