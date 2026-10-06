Completed the c8 coverage sweep for [pull request #68](https://github.com/melian-agent/melian/pull/68). The changed-line intersection exposed ten recorder lines, `testing.ts:33–34`, `48–49`, `51–52` and `61–64`, and the file importer’s read-error line, `file-import.ts:48`.

Recorder tests assert the REST response for string, URL and Request inputs, and 404 responses for absent operations, cursors and unrecorded requests. The importer regression asserts its error code, relative path, message and original cause after a read failure. No production source, dependency or lockfile changes.

The first exit-time reports discarded executed worker modules. Vitest also transforms source paths that native child fixtures load unchanged, so merging raw offsets before remapping created false gaps. A temporary afterAll hook flushes coverage and captures transform maps. c8 converts each capture before the source-level maps merge. The core testing guideline records the method. The environment-isolation test runs separately because Node injects NODE_V8_COVERAGE into children under c8.

Scoped line coverage rises from 99.07% to 99.46%. The recorder and file importer reach 100%; the introduced/uncovered intersection is empty. No source line is unreachable. All 1,413 package tests pass under coverage, with two skips. The full gate passes 1,703 tests, with 50 opt-in skips.

A native ESM namespace cannot be spied on directly. The read-error regression first calls `vi.mock("node:fs/promises", { spy: true })`, then replaces one call and restores it in `finally`.
