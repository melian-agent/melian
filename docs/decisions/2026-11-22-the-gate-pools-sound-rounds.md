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
  - its verifier ran, when its account names one. The host caps a finding a failed verifier never judged at advisory and reads that round as not reviewed, so the round covers nothing, though its findings still count, as [the section on a round that is not sound](#a-round-that-is-not-sound-lowers-nothing) says.

  A sound round covers a lens only when the level in that lens's own record is at or above the floor the base tip sets for every path the lens covers. A run with no level meets no floor.
- `replaces` stays empty, as the replaces-none ruling has it. Pooling needs no round to replace another.

This carries [the coverage ledger decision](2026-10-23-coverage-ledger-and-delta-review.md)'s rule, which the maintainer ruled on 2026-10-23, to the shared record: "any series of reviews that together cover the full diff at the configured level ... are a valid review". It is also what `--rerun` does on one host today: it runs the failed checks again, and their second run counts.

Rule 11 binds a publisher to the worst standing round. No publisher reads the shared record yet; the piece of issue #395 that builds one decides whether it binds the pooled verdict.

## The residual accepted

A failure the head itself causes only sometimes, such as a test that hangs on a race, reads as `failed` in one round and clean in another, and the gate passes on the clean one. Worst-of would block it. The maintainer accepted this, as `--rerun` accepts it on a host today.

What bounds it:

- A check's `failed` status says the check did not finish, not that it found something. Anything a check finds is a finding, and findings are pooled at their strictest, so a clean run hides only that another run did not finish.
- Only a round of exactly M..H covers. A round of an older base contributes findings, never coverage. When it is sound, its verifier's verdicts stand.
- Only a writer can add a round to `melian/state`, and the gate counts no record of a fork's head.
- A round whose verifier failed covers nothing, and a lens below the base tip's floor covers nothing. So the round that stands in for a failed check is one the host itself would read as reviewed, at the level the base tip asks for now.

## A dismissal a pooled round ends

The maintainer chose on 2026-11-20 that a shared dismissal holds only at the revision it was made at, and ends once any round is written at another revision. A revision is a base and a head. So a round of the same head at another base, a stacked parent's included, ends a dismissal made on the merge's own round when it is written later, even if it found nothing. The finding is then live, and the gate asks for the dismissal again. That fails closed. The gate's message names the round that ended the dismissal and the revision it reviewed, so a maintainer can see why a dismissed finding came back.

The gate asks again only for a finding its verdict holds live, and names each such dismissal once.

## A round that is not sound lowers nothing

At the gate, a round that is not sound contributes each of its findings as no verifier judged it, at the resolution it would have without the cap a host sets on an unjudged finding. It contributes no refutation, no lowering by its verifier, and no coverage. A round is sound when the host would read it as reviewed, its verifier having run: it replaces no round, names records of its own revision and one account, stands as reviewed under the base tip's resolution policy, and ran its verifier when its account names one.

A sound round of another revision of the same head, a stacked parent's included, gives no coverage, but its verifier's verdicts stand: a finding it refuted stays refuted, and one it lowered stays lowered. Its verifier judged the same code at the head. So does a sound round of the merge's revision whose account does not match the base tip's tier: it covers nothing, and its verdicts stand.

Two cases showed why, one in each of two passes:

- A round's verifier fails. The host caps each finding the verifier was asked about and never judged at advisory, and reads the round as not reviewed. The cap was safe only because the round read as not reviewed. The gate refuses the round coverage but counts its findings, so a second clean round of M..H that never raises the finding again covers every check, and a P1 would merge as advisory.
- A verifier judges some claims and then fails, for example because it finished outside its guarded accepted route, where a model the policy refused may have answered. Its refutation would drop a P1, and its lowering would turn a block into an acknowledgement, once another round covered every check.

A sound round's finding no verifier judged also counts uncapped, whatever its verifier check says. A verifier that leaves a claim unjudged fails, and a record that claimed otherwise must not bring the cap back.

What else a round carries, and whether it can lower a finding at the gate:

- A refutation by its verifier: covered by the rule.
- A severity its verifier lowered: covered by the rule.
- The `unverified` cap on a finding its verifier was asked about: covered, and lifted for every round.
- The `unverified` cap on a lens level that does not verify: not the round's. The base tip's policy sets which levels verify, and a sound round gets the same cap.
- The `pre-existing` cap, and a cause of pre-existing: the lens reports the cause, and the lens tool marks proving locations from the round's diff when the lens reports. No verifier re-scopes a finding. The base tip's policy sets the cap, as it does for a sound round.
- The `unproven-cause` cap: read from the lens's own evidence under the base tip's policy, as for a sound round.
- A dismissal: a maintainer's, not the round's judgement. It holds under the dismissal rules above.

Each finding counts at its strictest, so a later round's verdict does not clear a copy this rule counts, whether that verdict confirms the finding or refutes it. The same holds today for a finding one round's verifier confirmed and another's refuted. A maintainer then answers such a finding in one of two ways: dismiss it, or push a fix, which is a new head. The gate's message for a round that is not sound says so.

The coordinator chose these on 2026-11-22, the uncapped reading, the rule, and that a sound round of another revision keeps its verifier's verdicts, as answers on approach and not rulings, and told the maintainer, who may overrule them. Counting a sound parent's refutations as live would block stacked pull requests on findings a verifier already threw out, a cost the maintainer has not been asked about. That a later verdict does not clear the copy is the builder's reading of "each finding at its strictest". The coordinator will put that reading to the maintainer, since it decides how a head gets unstuck.

## Why

Immutable records and an empty `replaces` make worst-of a one-way door: any round that failed for any reason blocks its head for good. Pooling keeps every finding, which is what review is for, and asks only that each check has run once, soundly, on the exact merge.
