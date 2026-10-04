# `enola impact` measured on Melian's own tree

What a build of the `enola impact` command, from the Melian fork of Enola (branch `impact-cli`, two commits on upstream main three commits past v0.4.26), reported when run on Melian at `1a14808`. Measured on 2026-10-04 by the session preparing the fork; nothing was written to the checkout. No release of the fork exists yet, so nothing is pinned.

## Callers against a grep

For each symbol, callers in `packages/*/src` with the definition excluded, as `grep` finds them and as `impact --json --max-depth 1` lists them.

| Symbol | grep | impact | Missed |
|---|---|---|---|
| `reviewChangeset` | 2 (`cli/src/commands.ts`, `evals/src/goldens.ts`) | 2 | 0 |
| `createFinding` | 3 (`core/src/guardrails.ts`, `core/src/static.ts`, `pipeline/src/lens-tools.ts`) | 3 | 0 |
| `planPublication` | 1 (`pipeline/src/publish.ts`) | 1 | 0 |

Calls across workspace packages resolve: the graph turns an import of `@melian-agent/core` into a `calls` edge to the symbol in `packages/core/src`.

## Cost

`enola --generate`: 0.44 s wall clock, 78 MB peak memory; 325 files seen, 275 parsed, 2,246 facts, 4,825 call relations. Each `impact --json --max-depth 1` call: 0.21 to 0.37 s, about 30 MB when it reused the on-disk snapshot and 79 MB when it generated its own.

## What a consumer must handle

1. Test callers are not listed: Enola's default globs skip `*.test.ts`, so the five, seven, and one test files calling these symbols do not appear. Test fixtures do. Melian's Enola configuration must widen the globs if a lens is to see test callers.
2. The reported file and line are the calling function's declaration, not the call site. `packages/cli/src.review` is reported at `commands.ts:58`; the call is on line 109. A lens still reads the function.
3. Depth 1 also holds `file_ref` nodes, index re-exports and the calling files, beside the calling functions. Keep `kind: symbol` for call sites.
4. Symbol names are scoped to the directory, not the file: `packages/core/src.createFinding`. Two same-named functions in one directory share a node.
5. Do not read `facts.jsonl` for cross-package callers: there a call from the CLI targets `@melian-agent/core.createFindingsLog`, which matches no symbol fact. The graph resolves them, and the command returns them as `calls` edges.
6. A bare name is a guess: `createFinding` also matched `createFindingsLog`; the command picked the right one, exited 0, set `resolution.matched` and `resolution.ambiguous: true`, and said so on stderr. Pass the full fact name. At the default depth 3 it reported 40 dependents.

## Corrections to the earlier assessment

Melian has no tsconfig `paths` aliases; packages import one another by workspace package name through `package.json`, so the alias bug Enola's blind-spots document describes does not apply here. Melian has no `mcp-arch.yaml` and declares no providers.

## Contract of the command as built

`enola impact [flags] <target> [repo|config]`, flags before the target, a scoped target quoted as one argument. No flags prints a summary; `--list` prints dependents by depth; `--json` prints the `impact_analysis` tool's `output_mode=full` document, byte-identical to the tool's. `--max-depth` 1 to 10, default 3; `--max-nodes` 1 to 500, default 200, counting the target; `--include-forward`. Exit `0` with a report, `2` when it could not run, when the target resolved to no node or was too ambiguous to pick (the document still carries `resolution.candidates`), or on a usage error. The command reuses the on-disk `.enola/` snapshot when it describes the working tree under the same build and configuration, and otherwise generates one in memory and writes nothing.

What this settles for the plan's step 11: the extractor resolves Melian's own imports and calls, which was the spike's exit criterion. The remaining work is the fork's release branch and workflow, the manifest entry, and the consumer rules above.
