# Resolution per lens and per rule, as built

Status: built in milestone 2, step 18, "Resolution per lens and per rule".

Supersedes: [2026-10-12-resolution-per-lens-and-per-rule.md](2026-10-12-resolution-per-lens-and-per-rule.md)

The supersession is in part. The decision log retires a superseded file whole, so this file restates every clause of that decision that still holds, as built. That decision superseded [the out-of-diff decision](2026-10-03-out-of-diff.md) in part, and [the cap's section](#the-cap-on-pre-existing-findings) carries forward the clauses of it that survive. What changed from the superseded text: the pre-existing cap sets no gate of its own; a wholly refuted report does not count beside one that stands; the unjudged cap applies per report; the caps on a cause read the merged defect, where the superseded text said each member gets its own caps; and the points under [What the step chose](#what-the-step-chose).

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

Said straight: a pre-existing finding never resolves `block`. By default it is advisory. A folder that opts in may cap a severity at `acknowledge`. The finding then resolves `acknowledge`, and is treated exactly as any `acknowledge` finding is, in the verdict, the status, and the outputs. The step builds no gate of its own. The superseded text said such an acknowledgement gates the merge. That rested on a wrong belief about what `acknowledge` does: no `acknowledge` finding fails the published status. Whether one should is a question about `acknowledge` across the repository, not about pre-existing findings, and it is left to the readiness check.

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
- Neither notice resolves below `acknowledge`. None of the new keys can lower it: no mapping and no ceiling under `guardrails` applies to it.
- Melian compares the parsed `resolution` value at the base and at the head with its own loaders. A side that does not parse counts as changed.
- A lens's default is compared as it takes effect in the folder its `LENS.md` governs. It also comes through `extends`, and from whichever file of that name is nearest. So a file that drops `extends`, or a new nearer file with no `resolution`, draws the notice though neither writes the key.
- Such a notice resolves through the files' severity tables alone. It is marked in the typed field beside its class, and the floor reads the mark. A notice on a `LENS.md` that leaves its resolution alone has no floor, as before.

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
