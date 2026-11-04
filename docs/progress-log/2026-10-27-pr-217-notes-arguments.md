[Fix pass 3](https://github.com/melian-agent/melian/issues/212#issuecomment-6434541959) for [pull request #217](https://github.com/melian-agent/melian/pull/217).

The CLI deliberately passes `notes: false` when `--notes` is absent, matching the boolean defaults for `trustHead` and `cold`. The four existing argument assertions omitted that field. Their expected objects now include it. Two new cases assert the complete arguments with `--notes` absent and present. Production behaviour and the implementation plan stay unchanged.

On starting head `b648a43cb297bd1ece170c5334fc2e8472f6465f`, `npx vitest --run packages/cli/test/main.test.ts` failed four tests with `expected "review" to be called once with arguments`. Each received object contained the unexpected `notes: false`. After the assertion updates, all 52 tests passed. Targeted Biome and `git diff --check` passed.

The scratch runner `tmp/quiet-output-fix3/probe-notes.py` replaced the forwarded value with `false`, then `true`, one at a time. The new supplied-flag case killed the first probe; the absent-flag case killed the second. Each run exited 1 with one assertion failure and one passing case. The runner restored the production file after both probes. Logs: `tmp/quiet-output-fix3/notes-false.log` and `tmp/quiet-output-fix3/notes-true.log`.

The [complete inventory](2026-10-27-pr-217-fix3-mutants.json) has zero production mutants, zero omitted and zero unmutated paths. This pass changes only tests and progress records; its two extra probes cover unchanged production code.

The first CLI-package run used default worker concurrency. It reported 18 failures across six files while host load exceeded 50, then was stopped with exit 130. Five-second timeouts dominated those failures. A repeat with two workers reported no failures before it too was stopped with exit 130. The direct task instruction limits sandbox validation to targeted files, so the host still owes the whole CLI suite. Both package attempts removed the inherited `MELIAN_STATE_DIR`, as the earlier pass's progress entry requires. Logs: `tmp/quiet-output-fix3/cli.log` and `tmp/quiet-output-fix3/cli-two-workers.log`.

`npm run check` was not run in this sandbox. The host owns that gate.

After restoring the probe edits and stopping the package attempts, the final targeted run passed all 52 tests in `main.test.ts` (exit 0). Log: `tmp/quiet-output-fix3/main-after.log`.
