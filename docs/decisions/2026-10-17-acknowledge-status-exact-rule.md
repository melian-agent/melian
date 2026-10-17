# An unresolved acknowledgement fails the status, as built

Supersedes: [2026-10-16-acknowledge-fails-the-status.md](2026-10-16-acknowledge-fails-the-status.md)
Supersedes: [2026-10-13-resolution-as-built.md](2026-10-13-resolution-as-built.md)

Status: milestone 2, step 28, [pull request #142](https://github.com/melian-agent/melian/pull/142).
The attack held with changes. This file records the coordinator's rulings and restates the surviving resolution contract below.

## Problem and choice

Only blocks failed the published status. An acknowledgement required no answer.
A changed `melian.yaml` could draw a policy notice, remain unanswered and merge under a green required status.
The coordinator stopped such findings in the queue, while the status passed them.
[Pull request #117](https://github.com/melian-agent/melian/pull/117) exposed that mistaken belief about the gate.

An unresolved finding that adjudication resolves `acknowledge` now fails `melian/review`, as a block does.
A maintainer dismisses it by ID, with a reason, and publishes again.
The lifecycle carries that dismissal across revisions until its trigger changes.
Reading a notice or replying on GitHub does not dismiss it.

Policy notices have no exemption. An undismissed notice that resolves `block` or `acknowledge` fails.
Every notice at those resolutions needs a stored dismissal, including notices on policy, standards and analyser configuration.
The maintainer accepts that work. The coordinator's former policy-notice exception cannot clear the required status.

## Exact rule after the attack

- Count N, blocks B and unresolved acknowledgements A over `verdict.counted()`.
  This excludes members lifted only from silent to advisory under “Pre-existing, important”.
  An opted-in pre-existing acknowledgement counts, new or carried. Dismissed and refuted findings do not.
- An incomplete review maps to `error` first. Otherwise B + A greater than zero maps to `failure`.
  The description is `N finding(s), B blocking, A unresolved acknowledgement(s)`, with ordinary singulars.
  Example: `1 finding, 0 blocking, 1 unresolved acknowledgement`.
- With no blocks or acknowledgements, advisory findings give `N finding(s), none blocking`.
  No counted findings gives `Passed`, unless dismissals stand: then it gives `0 findings, N dismissed`.
- `blocking` continues to mean blocks alone. Review exit codes stay 0 passed, 1 blocking, 2 not reviewed and 3 findings without blocks.
  A successful publication still exits 0 even when it publishes failure.
- Terminal, GitHub review body and ledger state the verdict's status mapping.
  While an acknowledgement remains, they ask for dismissal with a reason and publication.
  The command names the pull-request changeset: `melian dismiss "#N" <id> --reason <text>`.
  Dismissing a range does not dismiss a pull request. The review event stays `COMMENT`.
- Policy notice IDs stay stable. Each notice carries a trigger whose hash is SHA-256 of `blob:` followed by Git's head blob ID.
  Git supplies the ID; no file content is re-derived. An absent head path uses the empty ID after that prefix.
  This covers deletions and the old side of renames. A failed Git lookup refuses the check.
  A non-UTF-8 policy path also refuses: its displayed name cannot be passed back to Git as its original bytes.
  Treating that name as absent would keep one trigger hash across every file change.
  Any blob change reopens a dismissal; another file changing does not.
  A notice stored without a trigger reopens once when first reported by this build, failing closed.

## Dismissal authority and visibility

Core trusts lifecycle state. Git author text is attribution, not authentication.
The writer whose token publishes local dismissals attests them. GitHub itself requires push access to write a status.
No extra permission clause gates a dismissal-bearing success.
An installation token cannot read `/user`; unknown login or permission must not turn such a success into error.
With `trust.writers: false`, the existing trusted-host error still wins.
The future Actions host must authorise dismissal commands. This step adds no comment command.

`melian publish` prints each dismissal it attests: ID, rule, file, dismisser, time and reason.
The review body names dismissed findings in a short list, with reasons, without publishing the git identity.
The ledger keeps its dismissal list and now renders the status line on every publish.
This covers a refused follow-up round and an older review body with the same fingerprint.
The CLI makes carried dismissals visible to the publisher; the all-dismissed status also names their count.
A dismissal revision is deferred; the stored timestamp remains its time.

## Resumed publications

A publication resumed after upgrade uses this mapping, including a round planned by an older build.
A saved computed success has no authority. Saved verdict, finding IDs, fingerprint and round number remain authoritative for that round.
The publisher maps the current stored verdict before posting.
A pending older verdict posts as planned, followed by the current verdict when they differ.
Signed accepted posts recover without duplication.
No background task rewrites completed publications; explicit publication updates their status and ledger.
A fixture written by the preceding build and an SQLite reopen test prove this contract.

## Dependencies on steps 29 and 30

Step 29 owns verifier lowering and refutation.
A P2 acknowledgement lowered to P3 can resolve advisory and pass this gate.
Its proposed floor covers `trust-boundary` and approval-guarding `untested-behaviour`; other lowered P2s still pass by design.
When every claim is refuted, adjudication excludes the defect altogether.
Step 29 must settle whether a refuted trust-boundary defect receives a floor too. Step 28 changes neither rule.

Step 30 owns nested policy keys other than `resolution`.
A nested file can still change `guardrails.*`, `lenses.*.enabled`, `paths`, `level`, `static.*`, `tiers` or `stages`
without a forced notice where its parent disabled the guardrail.
Step 18 already forces resolution notices under base policy; this step makes those notices fail until dismissed and reopen after blob changes.

## Design changes and as-built record

The pre-existing resolution paragraph now gives opted-in acknowledgements the repository-wide status gate.
The CLI publication section describes failure, dismissal attestation, resumed publication and unchanged exit codes.
Core and GitHub guidelines state the mapping; CLI guidance and all three skills relay dismissal output.

The producer fills the existing optional `FindingTrigger.hash`, a SHA-256 field, from Git's blob identity.
Finding identity and the verdict fingerprint algorithm stay unchanged.
Findings document version 9 adds the accepted trigger hash and affected proof hashes to each new dismissal.
The dismissal accepts content at its own revision. Different content reopens it regardless of revision order.
Matching content stays dismissed. Affected findings retain their proof-union comparison against the revision’s hunks; changed citations alone do not reopen them.
A dismissal accepts the whole accumulated proof union, plus its revision’s cited proof. It never drops earlier causes when that revision cites fewer hunks.
A version-8 dismissal has no accepted trigger and retains the earlier behaviour.
The migration branches on the source version and never invents that field.
An SQLite fixture recorded by main’s own code at `e0a9d00f` proves the legacy migration and a new dismissal across a second reopen.
Attached review tasks also recheck their stored sightings before verification and adjudication.
That reopen changes lifecycle alone, keeping the cached sightings and verification intact.
The real lens-and-verifier regression proves a code finding still fails when the head returns to A.
The real review and dismissal regression runs A, B dismissed, then A, and requires failure at the second A.
The publish task advances from version 3 to 4 to return attested dismissal snapshots with revision and round identity.
Its migration keeps version-3 timing and preserves the earlier versions’ legacy timing marker.
Old and new readers already compare that hash opaquely.
The preceding-build fixture covers old triggerless dismissal state and pending publication across SQLite reopen.
Check replacement upserts before pruning stale sightings, so reopening compares the preceding trigger even at the same revision.
The replacement-path reopen test publishes the reopened notice and asserts a failed status.
Publication returns each posted or recovered round’s dismissal snapshot and the current ledger’s snapshot.
The CLI prints these instead of rereading only the current verdict; identical snapshots appear once.
A failed publication keeps posted rounds’ attestations in Pi’s optional error detail.
PublishError carries them to the CLI, including a failed resumed task followed by a fresh task.
The CLI prints them before rethrowing the failure. No task input, checkpoint or result schema changes.
The ledger’s dismissal section reads Verdict.dismissals(), sharing the review body’s legacy-member fallback and report enumeration.
SQLite tests cover a pending older round with different dismissal membership and a version-3 task recorded by its own code.
The coordinator runs `static.mutation` on the host before the first full round.

## Resolution contract carried forward

The following clauses retain step 18's precedence, caps, floors, examples, diagnostics, goldens and accepted costs.
The only replaced clause is its historical claim that acknowledgements do not fail the published status.

Problem: a folder's `melian.yaml` maps each severity to `block`, `acknowledge`, `advisory`, or `silent`, and that one table serves every check. A team cannot say that one lens only advises in one folder, or that one rule blocks in another. The only levers are the whole table and switching a lens off.

Example: a cleanup lens reports a reuse finding at P2. The folder's table says P2 needs an acknowledgement, which suits a correctness finding. For a cleanup finding it is too much, so the team either lowers P2 for every lens or disables the cleanup lens.

Choice: a `melian.yaml` may map severities for one check and for one rule, beside its table, and may set a ceiling for either. A lens may declare a default of its own. The nearest file that speaks about a finding wins outright.

## The shape

```yaml
resolution:
  P0: block
  P1: block
  P2: acknowledge
  P3: advisory
  nit: silent
  preExisting:
    P0: acknowledge
  checks:
    lens.cleanup:
      ceiling: advisory
    lens.trust-boundary:
      P2: block
      rules:
        terminal-escape: { P1: acknowledge }
    static.biome:
      rules:
        biome/suspicious/noExplicitAny: { P2: advisory }
    guardrails:
      rules:
        guardrail/forbidden-patterns: { ceiling: acknowledge }
```

- `resolution.checks` is keyed by check name, as a tier spells it: `lens.<name>`, `static.<tool>`, or `guardrails`.
- An entry may map any of `P0` to `P3` and `nit`, and may set `ceiling`. Both take `block`, `acknowledge`, `advisory`, or `silent`.
- An entry's `rules` is keyed by rule ID, as the check's findings carry it. A rule entry takes the same mapping and `ceiling`.
- A rule sits under its check, because two lenses may share a rule ID.
- `resolution.preExisting` is the cap on pre-existing findings, by severity. [Its own section](#the-cap-on-pre-existing-findings) describes it.

A lens declares its default in its `LENS.md` front matter, in the same shape without `rules`. It may set a mapping and a ceiling. A ceiling is the usual one:

```yaml
resolution: { ceiling: advisory }
```

## Precedence

Nearest file wins outright. For a finding at severity S, from check C, under rule R, at a path:

1. **Find the nearest file that speaks.** Walk from the finding's folder to the root. A `melian.yaml` speaks about the finding when it writes a mapping for S: in a rule entry for R, in a check entry for C, or in its own table. It also speaks when it sets a ceiling on R or on C. A value the file merely inherits is not written.
2. **A mapping speaks for its own severity only.** A rule entry that maps only P1 does not speak for a P2 finding of that rule. A ceiling speaks for every severity: a file that sets one on the rule or the check has spoken about every finding of it.
3. **That file decides the whole result, mapping and ceiling both.** Nothing from a farther file applies once a nearer file has spoken.
4. **Specificity orders entries only within that file.** The requirement is the rule entry's mapping for S, else the check entry's, else the table's. The ceiling is the rule entry's, else the check entry's. A ceiling in that file caps a mapping in that file.
5. **What the file leaves out comes from Melian's built-in table.** A file that speaks only through a ceiling takes its requirement from the built-in table, never from a farther file. A file that sets no ceiling has none.
6. **If no file speaks, the lens's declared default applies.** Where that default maps no S, Melian's built-in table does.
7. **The result is the lesser of the requirement and the ceiling.** A ceiling can only lower.
8. **The caps apply next, then the floors**, as [Trust](#trust) lists them.

A user's preference files layer over every committed file today, in a review of the working tree. They come first on the walk.

## The accepted cost

A file that writes its own severity table overrides a lens's declared default, unless it restates it. A cleanup lens declares `ceiling: advisory`. A repository whose root file writes `P2: acknowledge` has spoken about every P2 finding, the cleanup lens's among them. Its P2 cleanup findings now need an acknowledgement. The repository restates the ceiling under `checks` to keep it.

The same holds between files. A folder that writes `P1: block` overrides every rule entry, check entry, and ceiling a farther file wrote for P1 findings. This is the price of a rule a maintainer can hold in one sentence: the nearest file that mentions the finding decides.

Two diagnostics make the cost visible.

- `melian findings` and `melian review` name, for each finding, the file and the entry that decided: the rule entry, the check entry, the table, the lens's default, or the built-in table.
- `melian doctor` lists, for each file that speaks, each lens default and each farther value it now overrides. That covers a file that writes a table, and one that speaks only through a ceiling or a rule entry. It lists by structure: a farther value is listed when the file speaks for a finding the value would have decided, even where the result is the same. A value the nearer file restates in an entry of its own is not listed.

## An example with two folders

```yaml
# melian.yaml
resolution:
  P2: acknowledge
  checks:
    lens.cleanup: { ceiling: advisory }
    lens.trust-boundary:
      rules:
        terminal-escape: { P1: acknowledge }

# services/payments/melian.yaml
resolution:
  P1: block
```

One worked finding: `trust-boundary` reports `terminal-escape` at P1 in `services/payments/src/log.ts`.

1. The walk starts at the payments file. It has no rule entry for `terminal-escape` and no check entry for `lens.trust-boundary`. Its table writes `P1: block`, so it speaks.
2. That file decides. The requirement is `block`, from its table. It sets no ceiling.
3. The root's rule entry, `P1: acknowledge`, never applies.
4. The result is `block`.

The same finding in `docs/guide.md` walks to the root. The root speaks through its rule entry, which maps P1, so the result is `acknowledge`.

A second finding: `cleanup` reports `reuse` at P2 in `services/payments/src/ledger.ts`. The payments file writes no P2 and nothing for `lens.cleanup`, so it does not speak. The root speaks twice over: its table writes P2, and its check entry sets a ceiling. The requirement is `acknowledge`, the ceiling is `advisory`, and the result is `advisory`.

A third finding shows the cost: `cleanup` reports `reuse` at P1 in the same file. The payments file writes P1, so it speaks and decides. It sets no ceiling for `lens.cleanup`, and the root's does not apply. The result is `block`. `melian doctor` lists the root's ceiling as overridden by the payments table for P1. To keep the ceiling, the payments file restates it.

A fourth case is easy to miss. A folder that writes only `checks: lens.cleanup: { ceiling: block }` has spoken about every cleanup finding. The root's `P2: acknowledge` no longer applies there, and the requirement comes from the built-in table. `melian doctor` lists that too.

## Merged defects

One defect can carry reports from several checks. Every member claim resolves under its own check, rule, severity, and path. Each member gets its own mapping and its own ceiling: the policy is per report. The two caps on a cause read the merged defect instead. A merged defect takes the strongest cause any report proved, with the evidence that proves it, and a `pre-existing` cap or an unproven `affected` cap applies only when that merged cause calls for it. So one report's severity and another's proof combine, as they did before this step, and a merge never lowers what blocks. The cap on an unjudged lens report stays the report's own. The defect takes the strictest result among its members, and the floors then apply to the defect.

Example of the merged cause: one lens reports a P0 on a line nothing ties to the change, and another check reports the same line at P3 as introduced. The defect is an introduced P0 and blocks under the built-in table. Resolved with each report's own cause it would be `advisory`: the P0 capped as pre-existing, the P3 advisory by the table. The answer does not depend on which member speaks for the defect, or on `ruleAliases`. A member here is a report with a finding ID of its own. A lens report whose every claim a verifier refuted is left out, unless every report of the defect is one.

Example: `lens.cleanup` and `static.biome` both report one P1 defect. The root table writes `P1: block`, the cleanup entry sets `ceiling: advisory`, and the Biome entry maps `P1: acknowledge`. The cleanup member resolves `advisory` and the Biome member `acknowledge`. The defect needs an acknowledgement. The cap on a lens finding no verifier judged applies to the lens member alone, never to the Biome member.

## Deterministic checks

Biome, tsc, Enola's rules, and guardrails resolve through the same keys. `static.biome`, `static.tsc`, `static.enola`, and `guardrails` are check names like any lens's. `static.mutation` joins them once step 16 lands, under whatever name it merges with. A key under `resolution.checks` must be `guardrails`, or start with `lens.` or `static.`, and a key under `guardrails.rules` must start with `guardrail/`. Any other is an `invalidValue` error naming the file. The `severity` keys those checks have today still set severity. These keys set what a severity requires.

Every guardrail finding's ID carries the guardrail's ID and no more: `guardrail/forbidden-paths`, `guardrail/required-files`, `guardrail/forbidden-patterns`, or `guardrail/policy-change-review`. Every `forbidden-patterns` rule, `focused-test` and `dynamic-import` alike, reports under the one ID. A line that several rules match is one finding at the strictest severity. The rule's own name appears only in the finding's prose. `guardrail/policy-change-review` carries two classes under one ID, a policy file and an analyser's configuration, each with its own severity.

So the keys under `resolution.checks.guardrails.rules` are:

- `guardrail/<name>`, for a whole guardrail. A finding stored before the typed field existed is keyed this way.
- `guardrail/<name>/<rule>`, for one configured rule, such as `guardrail/forbidden-patterns/focused-test`.
- `guardrail/policy-change-review/policy` and `guardrail/policy-change-review/analyser`, for the two classes.

For the last two forms, a guardrail finding carries a typed field: the names of the configured rules that matched, or the notice's class. The field stays outside the finding's ID, so no stored finding changed identity. Every guardrail names its rules there: `forbidden-paths` and `required-files` too, and a line `forbidden-patterns` could not scan, which names every rule left unchecked.

The two levels map onto the usual order. A `guardrail/<name>/<rule>` entry is the rule-level entry. A whole-guardrail entry, `guardrail/<name>`, is a check-level entry for every finding of that guardrail, named rules included. It comes before a mapping or ceiling written directly under `guardrails`. So a nested `guardrail/forbidden-patterns: { ceiling: advisory }` speaks for a `focused-test` finding, and a root entry for `guardrail/forbidden-patterns/focused-test` no longer applies there. A finding several rules matched resolves under each and takes the strictest.

## The cap on pre-existing findings

By default a pre-existing finding never resolves above `advisory`. [The decision that holds the verifier's re-scope](2026-10-13-re-scope-held-for-the-compiler.md) lists the important ones under their own heading. This key lets a folder ask for more than a listing.

```yaml
resolution:
  preExisting:
    P0: acknowledge
    P1: acknowledge
```

- Each severity takes `advisory` or `acknowledge`. The default is `advisory` for every severity. `block` is refused.
- The key is a cap, never a requirement. A pre-existing finding resolves to the lesser of its result under the precedence above and this cap. Where the table maps P0 to `advisory`, a cap of `acknowledge` changes nothing.
- The key merges upward as every other setting does: key by key, nearest file first. It is not part of the walk. A file that writes only `preExisting` has not spoken about any finding, and a file that speaks about a finding does not erase a farther file's cap. The maintainer confirmed this.
- A member of "Pre-existing, important" also has a floor of `advisory`, which [Trust](#trust) lists.

A pre-existing finding never resolves `block`. By default it is advisory. A folder may cap a severity at `acknowledge`.
It then takes the repository-wide acknowledgement gate above, with no separate gate for pre-existing findings.

A maintainer answers the finding with `melian dismiss` and a reason, as for every other `acknowledge` finding. The findings document keeps a finding's lifecycle by ID across revisions, so a carried finding that was acknowledged stays dismissed at the next revision. It leaves "Pre-existing, important" and the verdict, and is listed with the dismissed findings. No stored field was added.

### What survives of the out-of-diff decision

The superseded decision chose: introduced and affected can block; pre-existing never does and is raised once. Its reason: it keeps reviews in scope without missing breakage. What holds now:

- Introduced and affected findings can block.
- A pre-existing finding never resolves `block`. It is advisory by default, and a folder may opt in to `acknowledge` for a severity.
- A pre-existing finding is raised once. An important one is raised once per finding ID per pull request and then shown as carried.
- The reason stands: reviews stay in scope without missing breakage.

## Trust

What held before this step, and still holds:

- Every `melian.yaml` is a policy file, and `policy-change-review` reports a change to one. That guardrail is forced on for the root file only. A nested file is judged under the configuration of the directory above it, and a base file there may switch the guardrail off.
- A notice on a file named `melian.yaml` never resolves below `acknowledge`. A notice on any other policy file, a `LENS.md` among them, has no such floor.

What the step added:

- A change to any `resolution` key in any `melian.yaml` always draws the notice, wherever the file sits and whatever switch the directory above sets.
- A change to a lens's declared `resolution` in any `LENS.md` always draws it too.
- Neither notice resolves below `acknowledge`. None of the new keys can lower it: no mapping and no ceiling under `guardrails` lowers it.
- Melian compares the parsed `resolution` value at the base and at the head with its own loaders. A side that does not parse counts as changed.
- A lens's default is compared as it takes effect in the folder its `LENS.md` governs. It also comes through `extends`, and from whichever file of that name is nearest. So a file that drops `extends`, or a new nearer file with no `resolution`, draws the notice though neither writes the key.
- Such a notice resolves twice, through the files' severity tables alone and under its class's entries, and the stricter result stands. So an entry cannot lower it, and an entry the base wrote to ask more of a policy notice still applies. The head's edit is what marks the notice, so the mark must never shed a stricter rule. It is marked in the typed field beside its class, and the floor reads the mark. A notice on a `LENS.md` that leaves its resolution alone has no floor, as before.

The policy source stays the base for a pull request. A head that lowers its own lens's ceiling is reviewed under the base's keys, so it cannot lower its own findings. A lens's declared default is read from the same source as the lens. It is the default of the variant that reported: a moved file is reviewed by the lens of the folder it left, so a report under a nearer variant's folder may be the farther variant's, and the finding's source names which by its version. The folder it left may be any folder, so every variant the source defines is known by its version. A report whose version matches none takes the nearest lens's default. It is no part of the lens's version, so a lens that gains a default keeps its stored findings.

The caps that apply after resolution, all of them. The first two read the merged defect's cause and evidence, and the third the report's own verdicts:

- a `pre-existing` finding is never above its `preExisting` cap, `advisory` by default. The cap is read at the severity the mapping was read at;
- an `affected` finding with no proving `cause` location is never above `advisory`;
- a lens finding no verifier judged is never above `advisory`. This applies to a report, not to a defect: a judged report beside an unjudged one resolves in full.

The floors, all of them. They apply after the caps, to the defect:

- a policy-change notice on a `melian.yaml` is never below `acknowledge`, and from step 18 the two notices above share that floor;
- a `melian/injection-attempt` finding is never below `acknowledge`, whatever a mapping, a ceiling, or a lens's default says;
- a member of "Pre-existing, important" is never below `advisory`. This overrides a `silent` mapping or ceiling for members, on purpose. A member is a finding pre-existing by location whose original severity is P0 or P1; no re-scoped class exists. The floor reads the merged defect, which takes the strongest cause any report proved, so a defect an introduced report belongs to is no member.

Example of the second floor: a cleanup lens declares `ceiling: advisory` and reports an injection attempt. Every lens carries that rule. Without the floor the ceiling would hold the finding at `advisory`.

[Resolution ownership](2026-10-03-resolution-ownership.md) stands. A lens declares a default, which is configuration that travels with the lens. Configuration and adjudication still decide. No tool and no lens writes a finding's resolution, and `report_finding` still stores none.

## Goldens

They live under `packages/evals/goldens/resolution/`, scripted, with no model, beside unit tests in core for each rule of the precedence.

- a rule entry beats its check's, within one file;
- a check entry beats the file's table, within one file;
- a ceiling in a file caps a mapping in that file, and never raises one;
- the nearest table beats a root rule entry;
- a nearer file that speaks drops a farther file's ceiling, with its doctor line;
- a file that writes a table overrides a lens's declared ceiling, with its doctor line, and restating the ceiling keeps it;
- a lens's declared default applies when no file speaks;
- `melian findings` names the file and entry that decided;
- a deterministic rule resolves through the keys, and a configured guardrail rule under its own name;
- a merged defect with opposite policies, in both speaker orders, and with a speaker `ruleAliases` chose;
- a finding the verifier lowered resolves under the lowered severity;
- a pre-existing P0 that a nearer table maps to `block` is capped at `acknowledge` by a root `preExisting` cap, and one the table maps to `advisory` stays `advisory`;
- a rule entry that maps only P1 does not speak for a P2 finding of that rule;
- a file that speaks only through a ceiling drops a farther table's value, with its doctor line;
- a whole-guardrail entry in a nearer file speaks for a named rule's finding;
- a cleanup lens with an advisory ceiling reports an injection attempt, which resolves `acknowledge`;
- a merged defect whose lens member is capped does not cap its static member;
- a head that edits the keys is judged under the base;
- a `resolution` change in a nested `melian.yaml` whose parent switches the review off still draws a notice at `acknowledge`;
- a change to a `LENS.md` declared resolution draws one too, and a `guardrails` ceiling of `advisory` lowers neither.

## What the step chose

The superseded decision was silent on these.

- **Which file decided is stored with the finding, outside the fingerprint.** `melian findings` reads a stored verdict. So adjudication stores the file that spoke, the entry the requirement came from, the ceiling in force, and the cap or floor that then moved the result. For a merged defect it stores the report that gave the strictest result. The verdict's fingerprint leaves the field out, so a change in which file decided posts no new review. It leaves out what a guardrail finding matched too, which the finding's message already says. A verdict published before this step therefore keeps its fingerprint when it is decided again.
- **The lowering fence reads every report.** The verifier may not lower a claim to a severity that resolves `silent`. With per-check keys that depends on the check. The fence lists a severity any report of the defect resolves `silent`, so it refuses a little more than a fence per claim would.
- **A task decides only under the policy its review read.** A working tree's policy can change under one source. The adjudication task's input carries a fingerprint of the layers and lens defaults the review read, so a changed policy starts a new task. The task reads the policy again when it runs, and refuses to record a verdict when the fingerprint differs.

## What this gives up

Beside the accepted cost above, resolution no longer reads one merged configuration. It needs each file's own layer, which the loader holds.

Sightings of one finding ID are not resolved apart. The findings document merges every producer's sighting of one ID before adjudication, at the highest severity and the strongest cause, as it did before this step. Such a finding resolves once for each check that reported it, at those values. So the result is the strictest policy among those checks, applied to the highest severity. That errs toward the stricter result. `melian/injection-attempt`, the one ID every lens shares, has a floor of `acknowledge` under any policy. Carrying each sighting's severity and cause through to adjudication is step 21 of the plan, "Resolution per sighting", not started.

A dismissed pre-existing finding reopens as any dismissal does, when its trigger changes. A pre-existing finding has no trigger in the change, so in practice it stays dismissed for the pull request. A lens-only defect with one judged claim and one unjudged claim is no longer held at `advisory`. A task that finds the working tree's policy changed since its review ends failed, so `melian dismiss` then asks for a fresh review.

This extends [the resolution decision](2026-10-03-resolution.md) and [per-rule guardrail severity](2026-10-05-per-rule-guardrail-severity.md), and replaces neither: models still advise, and configuration still decides.
