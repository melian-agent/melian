# CI runner sizes and shards

Measured on 2026-11-18 for [issue #558](https://github.com/melian-agent/melian/issues/558), on the draft [pull request #560](https://github.com/melian-agent/melian/pull/560). Every merge waits for `.github/workflows/check.yml` twice, once on the pull request and once in the merge group. Over the 30 successful runs before this one, a run took 18.2 minutes at the median, 14.0 at best and 27.8 at worst. The three required Linux jobs ran on `blacksmith-4vcpu-ubuntu-2404`, with Vitest's default worker count and no shard.

## Method

A throwaway workflow on that pull request ran the check's steps on Node 24, the slowest of the three versions, in 13 arms. The arms were 4, 8 and 16 vCPU at Vitest's default worker count, which is the core count minus one. Two more set `--maxWorkers` to the core count. The rest split the suite with `--shard`: two shards on 4 and on 8 vCPU, and four shards on 4 vCPU. Each arm ran six times, in two workflow runs, [44210931581](https://github.com/melian-agent/melian/actions/runs/44210931581) and [44212828956](https://github.com/melian-agent/melian/actions/runs/44212828956), started at 00:49 and 01:05 UTC. All 39 jobs of a run started together, each within ten seconds of being queued. Each job split `npm run check` into timed steps and reported, as annotations, Vitest's outcome, `nproc`, the load average, and the tests that took over 2 and over 4 seconds. The first run's audit step ran a raw `npm audit` that main had replaced the day before, and failed with `continue-on-error`, so its Vitest timings stand and its annotations carry nothing. The second run reported all of it.

## Where the time goes

Vitest is 95% of a job. Everything else, at the median over all 78 jobs, takes about 25 seconds: `npm ci` 4 s, the apt step 6 s, Biome 3 s, the pin, release-age and tools scripts 5 s together, tsc 3 s and the audit 1 s. Checkout and setup-node take about 5 s more, and the pack-and-install step on Node 24 13 s.

## How the suite scales

"Wall" is a job's whole time, or the slowest shard's for a sharded arm.

| Arm | Wall median | Wall range | Vitest median | Tests over 4 s | Failed |
|---|---|---|---|---|---|
| 4 vCPU, default (today) | 11.7 min | 10.0–12.4 | 668 s | 35–53 | 0 |
| 8 vCPU, default | 6.3 | 5.8–7.3 | 343 s | 42–52 | 0 |
| 8 vCPU, 8 workers | 6.4 | 5.1–8.3 | 350 s | 41–80 | 0 |
| 16 vCPU, default | 3.9 | 3.2–4.5 | 203 s | 40–44 | 0 |
| 16 vCPU, 16 workers | 4.0 | 3.5–4.6 | 207 s | 46–54 | 0 |
| 2 shards, 4 vCPU | 6.5 | 5.2–8.3 | 335 s | 16–27 a shard | 0 |
| 4 shards, 4 vCPU | 4.3 | 3.8–5.0 | 216 s | 7–15 a shard | 0 |
| 2 shards, 8 vCPU | 4.3 | 3.8–4.7 | 181 s | 18–31 a shard | 0 |

Every unsharded job ran all 10,803 tests, and 56 were skipped, the macOS-only tests that `check (macos, 24)` runs, as on main. No test failed in any job. The count of tests over 4 seconds does not grow with the worker count, apart from one run of 8 workers on 8 vCPU. The slowest test took 23 to 24 seconds at every size, so it is a floor of the suite, not contention. The one-minute load average at the end of a job stayed at about one per core.

Setting `--maxWorkers` to the core count gains nothing over the default. Vitest scales almost linearly to 8 vCPU, and by a further 1.6 times to 16.

Vitest's shards are uneven: the four shards' Vitest steps took 145 to 216 seconds at the median. The two-shard split is closer.

## Cost

These are estimates. The session that measured could not read Blacksmith's pricing page, so the prices come from search results quoting it and Blacksmith's documentation:

- An Ubuntu x64 runner of 2 vCPU costs $0.004 a minute, by [the pricing page](https://www.blacksmith.sh/pricing).
- A larger runner's minutes count as 2 vCPU minutes in proportion to its vCPU count, by [the instance types page](https://docs.blacksmith.sh/blacksmith-runners/overview). So a 4 vCPU minute costs $0.008. The $0.016 for 8 vCPU and $0.032 for 16 vCPU are inferred from that rule, not stated as prices.
- GitHub charges a platform fee of $0.002 per job-minute from 2026-03-01, on third-party runners too, by [Blacksmith's note on it](https://www.blacksmith.sh/blog/actions-pricing).

Each job is billed by the started minute, so a shard pays for its own setup and its own rounding. The maintainer is to check these figures against the organisation's Blacksmith billing.

| Arm | Billed minutes a Node version | Cost of the three Linux jobs |
|---|---|---|
| 4 vCPU, default (today) | 12 | $0.36 |
| 8 vCPU, default | 7 | $0.38 |
| 8 vCPU, 8 workers | 6.5 | $0.35 |
| 16 vCPU, default | 4.5 | $0.46 |
| 16 vCPU, 16 workers | 4.5 | $0.46 |
| 2 shards, 4 vCPU | 13.5 | $0.41 |
| 4 shards, 4 vCPU | 16.5 | $0.50 |
| 2 shards, 8 vCPU | 9 | $0.49 |

On 16 vCPU, a check run costs about $0.10 more than today and ends its Linux jobs about 7.8 minutes sooner. A merge runs the check twice, so it costs about $0.20 more and waits about 15.6 minutes less.

## Shards and the required names

A shard is no faster than one 16 vCPU job and costs more. It would also change the required status names, `check (22)`, `check (24)` and `check (26)`, which the `main` ruleset sets. And `check (macos, 24)` would need the shards' reports merged into one, since it reads the Linux report to choose its files.

## The macOS job

`check (macos, 24)` needs every Linux job, though it reads only Node 24's report. Over the 20 successful runs before this measurement, it waited a mean of 132 seconds, at most 473, for a Linux job slower than `check (24)`, and then ran for 275 seconds. On 16 vCPU the Linux jobs end close together: the Node 24 jobs' range was 3.2 to 4.5 minutes. So waiting for Node 24 alone would save under a minute, and would take Node 24 out of the matrix into a job of its own. Once the Linux jobs take four minutes, the macOS job's own four to five minutes is the longest part of a run. Starting it beside the Linux jobs would need its file list chosen without the Linux report.

## Follow-up

Two changes to the macOS job could shorten a run further, and neither is made here. It could wait for `check (24)` alone, which saves under a minute on 16 vCPU. Or it could start beside the Linux jobs, which would save its whole wait, about four minutes, but needs its file list chosen without the Linux report.
