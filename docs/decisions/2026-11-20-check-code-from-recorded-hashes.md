# The checks' code version comes from recorded module hashes

Amends: [Request keys as built](2026-11-14-request-keys-as-built.md), "What this gives up", whose hand-raised check versions this replaces

Amends: [A producer's code version comes from recorded module hashes](2026-11-18-code-versions-from-recorded-hashes.md), "What follows", which this carries out for the checks

Status: ruled by the maintainer on 2026-11-16, in the coordinator's session, on [issue #437](https://github.com/melian-agent/melian/issues/437#issuecomment-6906681894). The coordinator approved this layout, one producer for every check, on 2026-11-20, in its session. That approval is not a maintainer's ruling.

## Problem

A check run is reused when its request matches, and until now the request held Melian's own check code only as `checkVersions`, a number per check raised by hand. A number raised by hand is a number someone forgets. Example: a fix to a guardrail rule that missed a forbidden path lands without the `guardrails` number moving. A repeat review of a head the old build passed reuses that clean run, and the forbidden path stays unreported.

## The change

The check request holds `code`, `codeVersion("checks")`, in place of `checks`, the table of numbers. The `checks` producer in `scripts/code-hashes.mjs` has the entry `packages/pipeline/src/checks.ts`. TypeScript lists 102 modules reached from it, in core, decisions and pipeline. The gate's `scripts/code-hashes.test.mjs` fails, naming `checks`, when one of them changes without its recorded hash.

One producer stands for all five checks, since `checks.ts` runs every one. The guardrails run in its `runCheck`, beside the supersession review, and the static checks through `static.ts`, `enola-static.ts` and `mutation-static.ts`, all reached from it. Five producers would reach the same 102 modules and repeat each failure line five times. One request already keys the whole run, so a change to one check's code misses the whole run, as a raised number did.

## Fixed text

`writesFixedText` tells whether a run's request asks for check code that stores none of its tool's text, so another host may be shown its sightings. It compared each static check's number with the first version that stored fixed text. A request that holds `code` comes from a build after every such version, so a `code` that is a 64-digit lowercase hex digest proves fixed text for each static check, and any other `code` proves nothing. A stored request without `code` keeps the old rule on its numbers, so a run an older build stored is judged as before.

## What it costs

Every stored check run misses once, since no stored request holds `code`; the next review runs Biome, tsc, Enola and the guardrails again, which spends no tokens. After that, the checks' code version moves whenever one of the 102 modules changes: 49 of the 112 merges to `main` from 2026-11-06 to 2026-11-20 would have moved it. A check run reuses only within a head and base, so the cost falls on a repeat review of an unchanged head under a newer build, at a check run's minutes and no tokens.

## What it leaves out

A check task another build resumes after a crash still records under the first build's key. [The adjudication decision](2026-11-18-code-versions-from-recorded-hashes.md#a-build-decides-only-its-own-tasks) closes that gap for adjudication. The pull request for the model producers, the second part of [issue #437](https://github.com/melian-agent/melian/issues/437), closes it for them, and the check task is named there.
