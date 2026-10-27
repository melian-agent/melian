# 2026-10-26: second fix pass on the graph tools at b452cffa

Codex's review and Melian's round on [pull request #207](https://github.com/melian-agent/melian/pull/207), the graph tools for the design lens, each found one gap at b452cffa. Each fix's test failed first.

- 3957e3d3, with its tests completed in 152ab412: the name-only binary probe read any git failure as a binary file. Exit 1 with nothing on stderr now means binary; any other failure rejects the search with `gitFailed`. The tests fake a git that fails only that probe: one that dies, one that exits 1 and warns, and one that fails silently.
- 7899d350: no fixture set an exact name beside a longer name ending with it, so a lookup returning both survived. A core fixture and the tool fixture's `nested.src.unused` now fail against that union and pass at the head.

All 18 mutants of the fix commits, and the hand-made union mutant, were run by hand and killed.
