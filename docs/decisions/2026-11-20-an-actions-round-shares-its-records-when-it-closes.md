# An Actions round shares its records when the round closes

Status: built in [pull request #576](https://github.com/melian-agent/melian/pull/576), for [issue #397](https://github.com/melian-agent/melian/issues/397). The maintainer ruled on 2026-11-20, in the coordinator's session.

Amends: [Hosts share a record of facts behind a store port, and working state stays where it ran](2026-11-13-shared-record-behind-a-store-port.md), scoped to when an Actions round shares its records

## Problem

The shared-record decision says a host adds a review's records in batches as its tasks finish, with the round's closing record last. A runner that dies has then already shared every check and lens it finished, and its successor reruns only the task that was cut. Melian's design lens found, on pull request #576, that the `melian round` workflow does not do this.

## Decision

An Actions round shares its records only when the round closes. The round job hands the records over once `melian review` returns, and the `record` job relays them as one batch, which must hold exactly one round.

The jobs leave no other way. The round job runs the head's code, so it holds no write access to `melian/state`, as the shared-record decision's rule 9 requires. The `record` job holds that access and runs no head code, so it can start only after the round job ends. Nothing in a running round can add a batch.

A host round still adds its records in batches as its tasks finish. Only the Actions relay waits for the close.

## What it gives up

A cut Actions round loses its finished work. A round job that times out, or that its concurrency group cancels, shares nothing, and the next round reruns every check and lens it had finished. A round that finished triage, the static checks and five lenses, then timed out in the sixth, pays for all six again. That cost is what the batching rule exists to prevent.

[Issue #602](https://github.com/melian-agent/melian/issues/602) holds partial relays, which would hand over a cut round's finished batches and need a relay contract for a batch with no round record. When it lands, it retires this amendment or narrows it.
