# The gate pools the sound rounds of a head, and takes each finding at its strictest

Amends: [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md), rule 4's "the gate takes the worst standing round" and rule 9's "computes the verdict of each standing round ... and exits with the worst"

Status: the maintainer agreed on 2026-11-22, in the coordinator's session, for [issue #395](https://github.com/melian-agent/melian/issues/395). [Pull request #638](https://github.com/melian-agent/melian/pull/638#issuecomment-7071348733) records it.

## Problem

Rules 4 and 9 say the gate computes a verdict for each standing round of the head and exits with the worst, and that not reviewed is worse than blocking. A round stands until a round that counts names it in `replaces`. [The replaces-none ruling](2026-11-16-a-round-replaces-none.md) left every `replaces` list empty until this issue decides who may replace what. So every round ever relayed for a head stands for good, and records are immutable.

Example: host A reviews pull request #N at merge base M and head H. A provider's usage limit fails `lens.correctness`, so A's round reads not reviewed. A writer starts a new round, as the gate's own message says to. Round B, at the same M..H, runs every check clean and finds nothing. Under worst-of, A still stands, so `melian gate "#N"` exits 2 on H forever. Only a new push escapes, and a new push changes nothing about the code.

## Choice

The gate pools every round of the head whose base the tip holds:

- **Findings** are the union of every counted round's findings, each at its strictest resolution, then its lower severity. A block or an unresolved acknowledgement in any round fails the gate, so a later clean round never hides a finding.
- **The round of the merge keeps every finding.** The gate drops a finding whose file is not in the merge's diff only from a round whose revision is not the merge's own, the stacked case the maintainer's reading of 2026-11-18 covered. A round of exactly M..H hands over every finding, a pre-existing one in a file the change did not touch included, so an acknowledgement its policy keeps still fails the gate, as rule 9 says.
- **Coverage**: a check of the base tip's tier counts as covered when some sound round of exactly M..H ran it. A check no such round ran leaves the gate not reviewed, naming it. A round is sound when all of these hold:
  - every record it names is found, of its own revision, and it replaces no round;
  - its account names the base tip's tier and allows exactly the skips that tier gives;
  - its records stand as reviewed under the base tip's resolution policy;
  - its verifier ran, when its account names one. The host caps a finding a failed verifier never judged at advisory and reads that round as not reviewed, so the round covers nothing, though its findings still count, uncapped, as the section on them below says.

  A sound round covers a lens only when the level in that lens's own record is at or above the floor the base tip sets for every path the lens covers. A run with no level meets no floor.
- `replaces` stays empty, as the replaces-none ruling has it. Pooling needs no round to replace another.

This carries [the coverage ledger decision](2026-10-23-coverage-ledger-and-delta-review.md)'s rule, which the maintainer ruled on 2026-10-23, to the shared record: "any series of reviews that together cover the full diff at the configured level ... are a valid review". It is also what `--rerun` does on one host today: it runs the failed checks again, and their second run counts.

Rule 11 binds a publisher to the worst standing round. No publisher reads the shared record yet; the piece of issue #395 that builds one decides whether it binds the pooled verdict.

## The residual accepted

A failure the head itself causes only sometimes, such as a test that hangs on a race, reads as `failed` in one round and clean in another, and the gate passes on the clean one. Worst-of would block it. The maintainer accepted this, as `--rerun` accepts it on a host today.

What bounds it:

- A check's `failed` status says the check did not finish, not that it found something. Anything a check finds is a finding, and findings are pooled at their strictest, so a clean run hides only that another run did not finish.
- Only a round of exactly M..H covers. A round of an older base contributes findings, never coverage.
- Only a writer can add a round to `melian/state`, and the gate counts no record of a fork's head.
- A round whose verifier failed covers nothing, and a lens below the base tip's floor covers nothing. So the round that stands in for a failed check is one the host itself would read as reviewed, at the level the base tip asks for now.

## A dismissal a pooled round ends

The maintainer chose on 2026-11-20 that a shared dismissal holds only at the revision it was made at, and ends once any round is written at another revision. A revision is a base and a head. So a round of the same head at another base, a stacked parent's included, ends a dismissal made on the merge's own round when it is written later, even if it found nothing. The finding is then live, and the gate asks for the dismissal again. That fails closed. The gate's message names the round that ended the dismissal and the revision it reviewed, so a maintainer can see why a dismissed finding came back.

The gate asks again only for a finding its verdict holds live, and names each such dismissal once.

## A finding a failed verifier never judged

When a round's verifier fails, the host caps each lens finding the verifier was asked about and never judged at advisory, and reads the round as not reviewed. The cap was safe only because the round read as not reviewed. Pooling took that away: the gate refuses the round coverage but counts its findings, so a second clean round of M..H that never raises the finding again covers every check, and a P1 merges as advisory.

So the gate reads each such finding at the resolution it would have without that cap. Only the gate's pooling does this; a host's reading of its own round is unchanged. A copy that a round's verifier did judge counts as that round decided it. The cap a policy sets on a lens level that does not verify stays, since a round whose verifier ran sets it too.

Each finding counts at its strictest, so a later round's verifier does not clear the uncapped copy, whether it confirms the finding or refutes it. The same holds today for a finding one round's verifier confirmed and another's refuted. A fix, which is a new head, or a dismissal answers such a finding, as it answers any other.

The coordinator chose to read these findings uncapped on 2026-11-22, as an answer on approach and not a ruling, and told the maintainer, who may overrule it. That a later verdict does not clear the uncapped copy is the builder's reading of "each finding at its strictest".

## Why

Immutable records and an empty `replaces` make worst-of a one-way door: any round that failed for any reason blocks its head for good. Pooling keeps every finding, which is what review is for, and asks only that each check has run once, soundly, on the exact merge.
