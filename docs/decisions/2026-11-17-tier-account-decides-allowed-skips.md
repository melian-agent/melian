# One class decides which skips let a review pass

Status: the coordinator's answer of 2026-11-17 on [issue #547](https://github.com/melian-agent/melian/issues/547), on approach. It is not a maintainer's ruling.

Amends: [A round's accounting is a record of its own](2026-11-16-account-record.md), the account's `allowSkip`: one rule derives it, and a reader can check an account against it.

## Problem

A round's account names the tier's checks, a record for each, and `allowSkip`, the checks whose skip still lets the review pass. Until now `account()` in `packages/pipeline/src/review.ts` built `allowSkip` as it went, from facts scattered through the review. The record relay of [issue #397](https://github.com/melian-agent/melian/issues/397) and the record reader of [issue #395](https://github.com/melian-agent/melian/issues/395) take an account from the store, and had no rule to check it by.

Example: a forged account record names no checks and allows every skip. A round that reads only that account passes on another machine, with no record of any check.

## Decision

`TierAccount` in `packages/core/src/tier-account.ts` holds the rule. `TierAccount.of(config, tier, lenses)` takes the base's parsed `melian.yaml`, the tier, and the lenses the review knows: every lens it loaded, and those it selected for the change, each with the paths it covers and its band. Core never reads the diff; the caller passes the selection.

A skip passes for five reasons, and no other:

1. `checks.allowSkip` in `melian.yaml` names it.
2. It is a loaded, enabled lens of the tier that no selected lens covers, recorded as `no paths`.
3. It is a `decisions.*` question and no decision provider is configured.
4. It is `static.mutation`, skipped because the change has no production lines.
5. It is a selected lens whose band's floor is `skip`, which triage chose to skip, from input that was not cut.

A lens configuration disables is recorded skipped and is never allowed to skip. A lens no file defines is recorded failed.

`tierAccount.filled(records)` makes the record for each lens and question of the tier that no record holds. `tierAccount.allowSkip(facts)` derives the skips from the round's own facts, in the order the review always gave them. `tierAccount.refusal(account, facts)` returns `undefined`, or one code from a closed set:

- `otherChecks`: the account names other checks than the tier's, with the verifier's beside them at most once;
- `missingRecord`: a check it names has no record;
- `otherSkips`: its skips are not exactly those the five reasons give.

The code carries no record text. The review builds its account through `TierAccount`, and no other code derives `allowSkip`. The review's account holds what it held before: tests in `packages/pipeline/test/tier-account-review.test.ts` pinned it for each reason before the rule moved, and pass after.

Every fact the rule needs has a place in a shared record's schema or in the base's configuration, so no payload changes:

| Fact | Where it is | Field |
| --- | --- | --- |
| The tier's checks | configuration | `tiers`, expanded by `checksOfTier` |
| Skips configuration allows | configuration | `checks.allowSkip` |
| A decision provider | configuration | `decisions.provider` |
| A lens is disabled | configuration | `lenses.<name>.enabled` |
| The mutation skip's cause | check record | `result.cause` |
| Triage's choice per lens | triage record | `decision.answers`, each `question` and `chosen` |
| Triage's input was cut | triage record | `inputCut` |
| The level floor | configuration, not a record | the base's `lenses.<name>.level` for each covered path |
| Which lenses cover the change | the caller's selection from the diff | the paths each covers |

A missing or unreadable fact makes the account not match; it never allows a skip. With no triage record, no lens skips by triage. A mutation record with no cause allows no skip. A selected lens with no record gets none filled in, so it reads as never started.

No round exports a triage record yet: `ReviewRecords.triage` has the schema, and no production code calls it, so a round's export holds its counted records and its account alone. Until a round exports one, a reader that checks an account from shared records has no triage record, and refuses an account that allows a triage skip. That fails closed: a round whose lens triage skipped reads, on another machine, as not matching its account. [Issue #554](https://github.com/melian-agent/melian/issues/554) exports the record.

The default floor depends on whether the host trusts the head and whether triage's decider is calibrated: `careful` for an untrusted head and an uncalibrated decider, `quick` otherwise. Neither is ever `skip`. So the head's trust and the decider's calibration never decide a skip, and only a configured floor of `skip` does. A test in `tier-account-review.test.ts` holds this for all four combinations.

The review reads triage's cut from the change it rendered under its own nonce, and the triage record holds the cut of the same change rendered under the fixed identity nonce. Both nonces are 24 characters, so the two agree.

## What it gives up

A reader that checks an account needs the lens selection, which comes from the diff. Core does not compute it, so the reader must select lenses the way the review does. The relay and the reader, issues #397 and #395, call `refusal` with that selection.
