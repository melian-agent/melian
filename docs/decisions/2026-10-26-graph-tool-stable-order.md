# Graph lists use declaration identity order

Amends: [Lens graph tools](2026-10-24-lens-graph-tools.md), result ordering

Status: accepted on 2026-10-26 by the maintainer.

Reversing Enola's relations reversed resolved callees. With 2,001 edges, it also changed which callees survived the output bound.

Every graph-tool list sorts by name, file, numeric line and ID. Edge kind breaks ties between uses of one fact. Missing file and line sort as an empty string and zero. Unresolved names sort by name. Impact retains nearest depth first and sorts all callers at each depth before applying its node cap. Definitions, references and callees share the same fact comparator.

The graph's fact and relation order therefore cannot choose which rows a bound keeps. This replaces the earlier file-first order for references and impact. The graph remains advisory, with the same caveats and limits.
