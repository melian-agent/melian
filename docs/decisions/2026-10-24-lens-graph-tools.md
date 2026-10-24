# Lenses explore Enola's graph through Pi tools over the snapshot

Status: accepted on 2026-10-24 by the maintainer, who chose Pi tools over Enola's snapshot and CLI rather than its MCP server. The tools read the snapshot; none runs the CLI.

## Problem

Codex's adversarial review explores a change with a shell: it greps, reads, and follows calls as far as it likes. A Melian lens has `read_file`, `search` and `list_files`, and a list of up to 40 callers per changed symbol that the review computed before the lens started. To follow a call two levels up, or find who uses a type, a lens greps for the name and reads each hit, spending a tool call on each, and a grep cannot tell a call of `open` on `EnolaRun` from any other `open`.

Example: the design lens reviews a change to `EnolaRun.callers`. To ask what reaches it, it greps `callers(`, gets 30 lines across `callers.ts`, tests and comments, and reads several to rule each out. Enola's snapshot of the head already holds the answer: which symbols call `packages/pipeline/src.EnolaRun.callers`, resolved by declaration.

## Choice

Four read-only Pi tools answer from the head's Enola snapshot, the one the review already built and verified:

- `graph_definitions`: the declarations whose name matches, with file, line and kind.
- `graph_references`: every fact with a resolved edge to one declaration, by edge kind (calls, instantiates, names, imports, implements).
- `graph_impact`: what reaches one declaration through resolved calls and instantiations, declarations and top-level code alike, up to three levels and 200 callers.
- `graph_callees`: what one declaration calls, resolved targets with their location and unresolved ones by name.

Each tool reads the snapshot through `GraphCache` at the graph key the lens task already stores for its callers section, which the lens's policy now carries, so it answers about exactly the snapshot whose callers the prompt lists. Before reading, the tool checks that the key's tree is the head's, and refuses a graph of another revision. Enola names a declaration by its directory, so two files in one directory can share a full name; the tools that take a declaration also take its `file`. No process starts. A review without a verified snapshot gives each tool a result saying so, and the lens falls back on `search`. The tools are bounded like the others, at 48 KiB of shown text under `outputLimits`, count against the tools budget, and quote every name and path inside the review's boundary, since a head writes them.

A lens opts in by listing the tools under `tools:`. A lens that lists none keeps the three read tools. Melian's design lens lists all seven through its repository extension, which also tells it when each helps.

## Why

Enola 0.4.27 is an MCP server by default, with 22 tools. Melian does not use that mode:

- Lens tools are Pi tools, metered and refused by the lens's own budget and policy. An MCP server's tools would need a client in the pipeline, and a bridge to that metering.
- The server is long-lived. It starts a localhost dashboard unless told not to, and keeps usage across every repository it has served, outside the repository and Melian's scratch.
- A query is useful only against the head under review. A probe ran `enola impact` from a directory holding the snapshot but not the repository: Enola found the snapshot "not comparable" and generated a new one over the empty directory. A CLI or server query therefore needs a checkout of the head for each lens, which the lens tools do not have; they read git objects.

The snapshot is Enola's own answer. Its facts name each declaration and each edge Enola resolved, with the target's ID. Reading those edges asks the authority. The tools never resolve a name themselves: an edge Enola left unresolved stays unresolved and is listed by name, marked so.

`graph_impact` walks resolved call and instantiation edges only. `enola impact` also follows imports and file references, and the review keeps calling it for the callers section of the prompt. The tool is narrower on purpose, and its description says so.

## Which lenses

- `design` now, through Melian's repository extension.
- `contracts`, whose question is who calls a changed signature, and `removed-behaviour`, which asks what relied on deleted code: both next, once the design lens's rounds show the tools are used and cost little.
- `durability` would use `graph_impact` to find what a changed task phase reaches.
- The verifier is left out until its own corpus measures whether the tools help it judge.

The built-in lenses keep their tool lists until a live run measures the change. Editing a built-in's front matter changes its version for every user.

## Consequences

- The lens policy on each lens conversation gains an optional `graph`: the cache root and key parts the lens task input already stored. A lens an older Melian created has none, and its graph tools say the graph is unavailable. The lens task's input is unchanged.
- A tool parses the snapshot's facts on each call: about 130 milliseconds for Melian's own snapshot of 10,000 facts and 6 MB, and under 10 milliseconds for the queries.
- Enola's facts cover what its extractors resolve. On Melian's own graph, `visibleText` has 73 resolved references and 133 declarations within two calls. A method called through an instance, such as `run.callers()`, or a static method called through its class, such as `GraphSnapshot.create`, has none: Enola records those calls by the text the code wrote, not the declaration. The tools say an absent caller proves nothing, and `search` stays the way to find those.

## Searching a set of files

[Issue #204](https://github.com/melian-agent/melian/issues/204): `search` took one path and returned at most 200 matches. The design index links up to 64 files, so searching each at base and head could take 128 calls of the design lens's 45, and a term common in one file cut the search off before the file that mattered.

`search` now also takes `paths`: an exact set of up to 65 files, design.md and the 64 it may link. Each file is grepped on its own, with `--max-count` and a byte bound of its own. So each file gets an equal share of the 200 matches, and one file's long lines cannot spend another's. The block opens with each file that had more than its share or is no file at the revision. Then the files' first matches follow, then their second, so the output bound cuts deep matches before it drops a file. `path` and `paths` together are refused. Core's `searchRevisionFiles` does the search; a test runs it over 64 files, one holding 300 distractor matches.

