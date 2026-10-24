# 2026-10-25: lenses explore Enola's graph

[Pull request #207](https://github.com/melian-agent/melian/pull/207) adds four read-only lens tools over the head's verified Enola snapshot: `graph_definitions`, `graph_references`, `graph_impact` and `graph_callees`. Melian's design lens lists them. `search` takes `paths`, up to 64 exact files sharing its 200 matches, which closes [issue #204](https://github.com/melian-agent/melian/issues/204). Decision: [lenses explore Enola's graph through Pi tools over the snapshot](../decisions/2026-10-24-lens-graph-tools.md).

All 468 enumerated mutants were run by hand: 444 killed, 24 equivalent with reasons. One kill test found a file-set search that threw when its output passed the byte bound; cd9efcc2 fixed it.
