# The macOS tests run beside the Linux jobs, and a third job compares

Status: ruled by the maintainer on 2026-11-20, in the coordinator's session, for [issue #599](https://github.com/melian-agent/melian/issues/599#issuecomment-7030365386).

Amends: [2026-11-18-check-runs-on-16-vcpu.md](2026-11-18-check-runs-on-16-vcpu.md), the macOS job it left as a follow-up

## Problem

`check.yml` took 11.1 minutes at the median on the 16 vCPU runners, against 12.2 on 4 vCPU. The Linux jobs halved, to 4.7 minutes for Node 24. The macOS job waited for all three Linux jobs, because it read the Node 24 job's Vitest report to learn which files to run. It then ran for 5.9 minutes. In the same days its test step had grown from about 2.2 minutes to 5.4, because [issue #495](https://github.com/melian-agent/melian/issues/495) added `packages/pipeline/test/probing-level.test.ts` to its list. That file is 155 tests and takes 114 seconds on 4 cores.

## Choice

The macOS tests run in `test (macos, 24)`, beside the Linux jobs. That job needs nothing from Linux, because `scripts/macos-tests.json` lists what it runs:

- six named suites, run whole;
- the files that hold a test Linux skips, run whole;
- `probing-level.test.ts`, run with `--tags-filter=macos`, so only the tests that carry the Vitest tag `macos` run.

`check (macos, 24)` keeps its name and becomes a short Ubuntu job. It waits for both, and runs `scripts/compare-platform-reports.mjs` over the Node 24 Linux report and the two macOS reports. It fails unless the macOS test job succeeded and all six of these hold:

1. Every test Linux skipped passed on macOS. A test missing from the macOS reports has not passed. The list's `allowed` entry excuses one test, which needs root on both runners.
2. Each named suite ran on macOS, and every one of its tests passed. Each tagged file has at least one test that the Linux report shows carrying the tag, and each of those tests passed on macOS.
3. No test macOS ran failed. A test that the tag filter left out, which Vitest reports as skipped, is not counted.
4. The Linux report shows at least one skipped test. A report with none is broken, not complete.
5. Every file Linux skipped a test in is on the list. A file that is missing fails the run, and the message names the file to add.
6. Each macOS report says its run succeeded. A failed hook or an unhandled error fails a run whose every test passed, and the test statuses alone would not show it. Codex's adversarial review found the gap.

Checks 1 to 4 are the checks the macOS job made before; check 6 and the job's own result stand for the exit code that failed the old job. So no test Linux skips reaches `main` without passing on macOS. A wrong list can fail the run. It cannot pass a test that never ran, because check 1 counts that test as missing.

The tag is the marker, written in the test file. The workflow reads it through Vitest's filter. The comparison reads it from the Linux report, which lists each test's tags, so a lost tag shows as a tagged file with no tagged test, and fails check 2. A test of the script checks that the committed list's tag is the one the file uses and that `vitest.config.ts` defines.

## Which tests of the probing level still run on macOS

Twelve of the 155 tests carry the tag. Each one runs a real process whose ending the platform decides, or measures a probe's real time:

- "runs a round's probes one at a time, so each writes its head's tree alone", which times each probe's start;
- "runs the prober on its own tier, model and time limit, and the planner on the level's", whose probe hits a 0.3 second limit;
- "runs a probe again once in a review though its rerun shows nothing and two findings cite it", whose rerun is a `sleep` that a time limit ends;
- "says how a probe ended: timed out, cut, ended by a signal, or silent";
- "counts the probes' time in seconds";
- the four cases of "fails a level whose only probe of an attack %s": `sleep`, `yes | head`, `kill -9` and a `trap` on TERM;
- "fails a level that answered one attack while every probe of another showed nothing", "passes a level whose prober skipped, with its reason, an attack its probe showed nothing on" and "passes a level whose later probe of an attack ran to its end after one that showed nothing", each with a probe that `sleep` holds past its limit.

The other 143 no longer run on macOS. Linux is enough for them. Each drives the planner, the prober and the verifier on the fake model, and its probes run unconfined: a Node script that ends by its own exit, sometimes after an empty `printf` or a plain `exit 1`. What they test is Melian's own TypeScript: plans, budgets, records, reruns, telemetry and verdicts. Nothing in it reads which platform it runs on. The real sandboxes, seatbelt and bubblewrap, are tested by `probe-sandbox.test.ts` and the other named suites, which still run whole on macOS.

## What it gives up

- The list is kept by hand. A new test that skips on Linux fails `check (macos, 24)` until its file is added. Before, the macOS job found the file in the Linux report. The failure names the file to add.
- 143 tests of the probing level run on Linux alone. A new test in that file that depends on the platform needs the tag, and nothing finds it if it lacks the tag.
- The run has one more job and one more artefact, `macos-vitest-reports`.

## What it saves

A run now takes about as long as the slower of the Linux jobs and the macOS tests, plus a comparison of well under a minute. The tagged run of the probing level took 24 seconds on 4 cores, against 114 for the whole file. On the medians measured for the issue, a run should take about five minutes, against 11.1. The progress-log entry records the first runs' times.
