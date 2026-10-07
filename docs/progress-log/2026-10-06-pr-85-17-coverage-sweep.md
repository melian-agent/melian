# Sweep coverage of deferred review changes

[Pull request #85](https://github.com/melian-agent/melian/pull/85), ninth-round coverage pass.

The sweep intersects c8's uncovered lines with the branch's added ranges against origin/main. The three files introduce 595 lines: review.ts adds 128, standards.ts 416 and source.ts 51.

The pipeline and core suites cover every reachable introduced line. The only intersection is standards.ts lines 174–175, StandardsLoader.findPaths. StandardsLoader is private and never returned. Its standards-loading callers use readText, list, exists and isIgnored. StandardsInventory.inspect calls findPaths on the underlying SourceReader directly. No public API reaches this delegate. No test or production change is needed for the sweep.

Measured line coverage is 99.89% for review.ts, 99.61% for standards.ts and 100% for source.ts. Review's two uncovered lines predate this branch. The local report records the before and after measurements and gate results.

## Measuring with c8 and Vitest

Plain c8 misses Vitest's worker shutdown data here, including with the forks pool. An afterAll hook calling node:v8's takeCoverage collects it. Vite evaluates transformed modules under their original file URLs, so c8 also needs their inline source maps and generated line lengths. Applying transformed offsets to the original TypeScript invents uncovered lines inside calls that ran.

The local measurement hook uses node:inspector to read the generated scripts and their inline maps. A runner attaches those maps to V8's source-map-cache records before c8 reports. Generated scripts get distinct URLs so their offsets cannot merge with native child-process offsets. The maps still point to the original three files. Hit counts stay unchanged.

Instrumentation adds NODE_V8_COVERAGE to child processes and conflicts with the static tool's exact environment assertion. Coverage runs omit that one test; the full gate runs it unchanged. Native module mode is unsuitable here because namespace spies need Vite's module runner. No dependency or lockfile changed. The hooks, runner, maps and reports stay under tmp.
