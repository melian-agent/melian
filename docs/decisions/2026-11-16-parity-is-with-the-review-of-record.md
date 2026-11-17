# Parity is with the review of record, whichever lens finds the defect

Amends: [Restore the design lens clauses that partial supersessions retired](2026-11-08-restore-design-lens-clauses.md), "without loosening the goldens", for what a golden's expectation may accept

Status: built for [issue #511](https://github.com/melian-agent/melian/issues/511). The maintainer ruled on 2026-11-16, in the coordinator's session: "Parity is with the review of record, whichever lens finds the defect." The wording below is the builder's.

## The problem

A golden scores the whole review, but its expectation could name only one lens and one rule. The first live probing measurement, on 2026-11-16, showed what that costs. `trust-boundary-probe-claim-lost-release` plants a race that loses a claim's release. It has no hostile party, so the trust-boundary planner has nothing to plan for, and the correctness lens found it in every pass, under `state-ordering`, with the verifier's confirmation. The golden expected `fail-open` from `lens.trust-boundary`, so it scored a right finding as a false positive and the defect as missed. A reviewer of record who read that finding would have accepted it.

## The choice

- A golden's expectation names a `source` only where the defect is one that lens alone should find. Where the review of record would accept the finding from any lens, the expectation names none.
- An expectation may list `alternativeRules`: other rules under which the review of record would accept a report of the same defect. Its README says why each is the same defect.
- The ruling sets what a golden accepts, never one live run. A rule or a missing source enters a golden because a reviewer of record would accept that finding as the defect, and a golden is still never loosened to lift a lens's score over its bar.
- `lines` bounds where a finding may answer, so a wider rule or a missing source does not let a finding elsewhere in the file count. `trust-boundary-probe-claim-lost-release` names lines 77-78 of `claim.yml`, the branch its clean twin drops.

## Why

Melian measures whether a review catches what the review of record catches. A golden that credits one lens alone measures that lens's coverage and penalises the review for a right finding from a neighbour. Holding the accepted set to the reviewer of record, and each place to its lines, keeps the measurement as strict as the review it stands in for.
