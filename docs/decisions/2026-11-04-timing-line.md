# A builder reports the time GitHub can't see

Status: accepted by the maintainer, 2026-11-04.

Amends: [The plan's work lives in GitHub issues](2026-10-26-plan-as-issues.md), what a builder reports.

## Problem

The maintainer wants to know where a pull request's development time goes, so the loop can get faster. GitHub records commits, CI runs, labels, reviews and the queue, but not the gates, Melian rounds and reviews a builder runs between pushes. A builder can run anywhere, so no local log reaches everyone.

Example: on [pull request #256](https://github.com/melian-agent/melian/pull/256), 1.2 to 1.5 hours passed between most commits, and GitHub shows nothing in those gaps.

## Decision

Every report comment a builder posts on its pull request ends with a `Timing:` line: each gate, round and review with its minutes, each round's cost, and each wait with its cause. A timeline script, [issue #262](https://github.com/melian-agent/melian/issues/262), joins those lines to GitHub's own events.

## Why

A line in the comment the builder already writes costs nothing, and it lives where every builder can post and every reader can fetch. Published run details will carry each round's span once [pull request #221](https://github.com/melian-agent/melian/pull/221) lands, but not gates, other reviews or waits.
