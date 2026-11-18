# The check's Linux jobs run on 16 vCPU

Status: chosen by the coordinator on 2026-11-18, in its session, for [issue #558](https://github.com/melian-agent/melian/issues/558), which the maintainer asked for that day.

## Problem

Every merge waits for `.github/workflows/check.yml` twice, on the pull request and in the merge group. A run took 18.2 minutes at the median over 30 runs. Its three required Linux jobs ran on `blacksmith-4vcpu-ubuntu-2404`, where Vitest takes 95% of a job.

## Choice

`check (22)`, `check (24)` and `check (26)` run on `blacksmith-16vcpu-ubuntu-2404`, at Vitest's default worker count and with no shard. Only `runs-on` changes. The macOS job, the `melian round` workflow, `claim.yml` and `melian-review-group.yml` keep their runners.

## Why

[The run record](../research/2026-11-18-ci-runner-sizes.md) measured six runs of each option on Node 24. A Linux job took 11.7 minutes at the median on 4 vCPU, 6.3 on 8 and 3.9 on 16, and no test failed at any size. The count of tests over 4 seconds did not grow.

Setting `--maxWorkers` to the core count gained nothing over Vitest's default. Two or four shards were no faster than one 16 vCPU job, cost more, and would change the required status names and give the macOS job several reports where it reads one.

## What it costs

At the record's estimated prices, the three Linux jobs cost about $0.46 a run against $0.36, so about $0.10 more a run. The workflow runs on every push to a pull request, in the merge group, and on the push to `main` after a merge. In the week before this decision it ran 100 times for 11 merges, so the change costs about $10 a week, or $0.90 a merge. A merge waits for two of those runs, so it waits about 15.6 minutes less. The estimate rests on Blacksmith's per-vCPU rule and GitHub's per-minute platform fee, and the maintainer is to check it against the organisation's billing.

Once the Linux jobs take four minutes, the macOS job's own four to five minutes is the longest part of a run. The record sets out starting it sooner as a follow-up.
