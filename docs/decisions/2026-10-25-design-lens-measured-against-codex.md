# The design lens is measured against Codex by cohort and round time

Status: accepted on 2026-10-25 by the maintainer.

## Problem

`melian compare stats --lens design` measures the design lens against Codex's adversarial review, which the lens is meant to replace. Reviews of its first form found it mixed rounds that measure different things. `--since` kept or dropped a whole pull request by its first round, so a pull request that began before the design lens moved to Codex's route lost its later rounds. Rounds on the lens's earlier, low-effort route summed with rounds on the parity route. A merged finding credited the design lens even when the verifier had refuted the design lens's own claim.

## Choice

- With `--lens`, `--since` selects rounds by their own time, not by a pull request's first round. `--last` still selects the newest pull requests.
- The statistic keys each round by the lens as it ran: the version and level its check record names, with the model and reasoning level when the round left the committed route. Each cohort prints on its own, so the low-effort rounds never mix with the parity rounds. A round with no record of the lens counts in a cohort of its own.
- A lens earns no credit for a finding when the verifier refuted every one of that lens's claims on it, even when another check's claim keeps the finding valid.
- A Codex payload stays tied to its head by its file name alone, as AGENTS.md says to name it. The companion's payload records no head commit. A recorded head is tracked in its own issue.

## Why

Each rule removes a way the count could measure something other than the lens on its current route against Codex on the same heads. Keying by the version and level is what the check record already stores. The version changes when Melian's repository extension changes the lens's tier or budget, which is how the route change shows. A route set only in `melian.yaml`, with no lens change, shows only through the record's lineage when a round leaves the committed route; a later per-lens route, plan step 37, would make the route part of the version.
