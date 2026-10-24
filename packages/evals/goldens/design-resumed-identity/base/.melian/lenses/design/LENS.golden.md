---
name: design
extends: design
tier: medium
tools: [read_file, search, list_files, graph_definitions, graph_references, graph_impact, graph_callees]
budget: { findings: 8, tokens: 3m, tools: 150 }
---
To search every design file the index lists, at base or head, pass them all to `search` as `paths` in one call. To test an assumption against the code that relies on it, ask Enola's graph of the head before you grep. `graph_definitions` finds where a name is declared and gives its full name. `graph_references` lists what calls, constructs, names, imports or implements that declaration, and `graph_impact` lists what reaches it through calls, up to three levels away. `graph_callees` lists what it calls. The graph holds only the edges Enola resolved: a method called through an instance is often missing, so an empty answer proves nothing, and `search` finds the rest. Confirm each caller with `read_file` before citing it.
