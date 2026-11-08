# The walkthrough runs beside the lenses

Status: built for [issue #254](https://github.com/melian-agent/melian/issues/254).

## Problem

The walkthrough summarises the change for the reader. It needs the change, not the verdict, yet `melian review` ran it only after adjudication. Each round on 2026-10-26 and 2026-10-27 ended with 13 to 16 seconds of walkthrough and nothing else running, by the prepare spans of [pull request #206](https://github.com/melian-agent/melian/pull/206).

It waited for one reason: `summarizeReview` read the verdict's stored provenance to learn that the review was of a pull request and which plan routed its light model. Adjudication writes that provenance, so started any earlier, the summariser found none and did nothing.

## Decision

- `reviewChangeset` takes an optional `afterTriage` hook. It calls the hook once triage has decided, or found nothing to ask, before any lens runs.
- `melian review` starts the walkthrough from that hook, for a pull request without `--no-walkthrough`. It awaits the walkthrough after the review returns and before printing, and also before it closes storage, on every path. A review that fails before triage starts it once the review returns, as before.
- `summarizeReview` takes `origin` and `plan` from its caller. When `origin` is given, the two stand for the stored provenance: only a `pull-request` origin is summarised, and `plan`, or the configuration without one, routes the light model. A caller that passes no `origin` reads the stored provenance as before.

## Why

- After triage, not at the start, because a pending triage decision can replace a crashed review's lens selection. `summarizeReview` calls `harness.resume()`, which starts every pending task. Started before triage commits, it could resume a lens run that triage is about to replace, and that run would spend tokens. Once triage has decided, its commit and sweep have retired those tasks.
- The host passes the plan the review is running under, the same object `reviewChangeset` stores in the provenance, so the summary still quotes the review's plan. A summary that a crash interrupted attaches to its task by revision on the next review, which passes that review's plan, as the provenance would.
- The summariser already stores a note for every failure and never throws, so a failed walkthrough still leaves the verdict and the exit code alone.

## What this gives up

- A review that fails after triage can still store a walkthrough for the revision, where before it stored none. Publication reads a walkthrough only beside a decided verdict, so nothing posts it.
- The summariser's light model and triage's can now be asked at once. Credential commands still run once per process, because the store caches each read as a promise.
