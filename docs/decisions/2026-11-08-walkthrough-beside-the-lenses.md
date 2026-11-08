# The walkthrough runs beside the lenses

Status: built for [issue #254](https://github.com/melian-agent/melian/issues/254).

Amends: [Spans time a review's work between tasks](2026-10-24-review-spans.md), its rules that one step is open at a time and that no span overlaps a task, for the walkthrough alone.

## Problem

The walkthrough summarises the change for the reader. It needs the change, not the verdict, yet `melian review` ran it only after adjudication. Each round on 2026-10-26 and 2026-10-27 ended with 13 to 16 seconds of walkthrough and nothing else running, by the prepare spans of [pull request #206](https://github.com/melian-agent/melian/pull/206).

It waited for one reason: `summarizeReview` read the verdict's stored provenance. That told it the review was of a pull request, and which plan routed its light model. Adjudication writes that provenance, so started any earlier, the summariser found none and did nothing.

## Decision

- `reviewChangeset` takes an optional `lensesStarted` hook. It calls the hook once it has recorded its lens run in the review index and aborted any run that replaces, just before it waits for that run. A review that runs no lens never calls it.
- `melian review` starts the walkthrough from that hook, for a pull request without `--no-walkthrough`. It awaits the walkthrough after the review returns and before printing, and also before it closes storage, on every path. A review that fails before triage starts it once the review returns, as before.
- `summarizeReview` takes `origin` and `plan` from its caller. When `origin` is given, the two stand for the stored provenance: only a `pull-request` origin is summarised, and `plan`, or the configuration without one, routes the light model. A caller that passes no `origin` reads the stored provenance as before.

## Why

- At the lens run, not at the start or after triage, because `summarizeReview` calls `harness.resume()`, which starts every pending task. Until the review has recorded its lens run, the index still names any run a crashed review left, and that run passes every ownership check. Started then, the walkthrough could resume that run on a superseded plan, and it would spend tokens and write sightings before the review aborted it. Once the review has recorded its own run and aborted the replaced one, nothing stale is left to resume. Melian's design lens found the earlier placement, after triage, open to this.
- The host passes the plan the review is running under, the same object `reviewChangeset` stores in the provenance, so the summary still quotes the review's plan. A summary that a crash interrupted attaches to its task by revision on the next review, which passes that review's plan, as the provenance would.
- The summariser already stores a note for every failure and never throws, so a failed walkthrough still leaves the verdict and the exit code alone.
- The review's spans time its own steps, one at a time, so the walkthrough task now runs while they are open. That is the overlap this change is for, so the walkthrough task is the one task a span may overlap. Every other task still waits with no span open.
- The walkthrough's credential unlock is a span of its own, `unlock` under the parent `walkthrough`, recorded by `PrepareSpans.concurrent`. It may overlap any review step or task. `walkthrough` names no review step, so the ledger's preparation row, which sums the top-level spans, never adds the unlock's time to the review's own. Two rounds disagreed here: one found that timing the unlock under the open review step misattributed it, and the next found that leaving it untimed hid it. The maintainer ruled on 2026-11-08, in the builder's session, for a concurrent span. The next round found that a parentless span inflated the preparation row, and the maintainer ruled, the same day and in the same session, to give it the `walkthrough` parent.

## What this gives up

- A review that fails after its lenses start can still store a walkthrough for the revision, where before it stored none. Publication reads a walkthrough only beside a decided verdict, so nothing posts it.
- The summariser's light model and triage's can now be asked at once. Credential commands still run once per process, because the store caches each read as a promise.
