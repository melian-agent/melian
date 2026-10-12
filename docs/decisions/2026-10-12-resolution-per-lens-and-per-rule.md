# Resolution is configurable per lens and per rule, per folder

Status: planned for milestone 2, step 18, "Resolution per lens and per rule". Nothing here is built, and no key below exists yet.

Problem: a folder's `melian.yaml` maps each severity to `block`, `acknowledge`, `advisory`, or `silent`, and that one table serves every check. A team cannot say that one lens only advises in one folder, or that one rule blocks in another. The only levers are the whole table and switching a lens off.

Example: a cleanup lens reports a reuse finding at P2. The folder's table says P2 needs an acknowledgement, which suits a correctness finding. For a cleanup finding it is too much, so the team either lowers P2 for every lens or disables the cleanup lens.

Choice: a `melian.yaml` may map severities for one check and for one rule, beside its table. It may also set a ceiling for a check or a rule. A lens may declare a default of its own. Mappings resolve nearest file first. Ceilings are separate, and inherit.

## The shape

```yaml
resolution:
  P0: block
  P1: block
  P2: acknowledge
  P3: advisory
  nit: silent
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

A lens declares its default in its `LENS.md` front matter, in the same shape without `rules`. It may set a mapping and a ceiling. A ceiling is the usual one:

```yaml
resolution: { ceiling: advisory }
```

## Precedence

For a finding at severity S, from check C, under rule R, at a path:

1. **The requirement comes from the nearest file that maps S.** Walk from the finding's folder to the root. In each `melian.yaml`, look for a rule entry for R that maps S, else a check entry for C that maps S, else the file's own table. The first file with any of the three decides. Specificity orders entries only within one file.
2. **A file's table counts only where the file writes that severity itself.** A value it merely inherits is not written. So a folder that writes `P1: block` means it, whatever a rule entry in the root says.
3. **With no file mapping S**, the lens's declared default mapping applies, then Melian's built-in table.
4. **The ceiling is separate, and inherits.** A ceiling says a check or rule never requires more than a level. The ceiling in force is the nearest one a rule entry for R sets, in any file from the folder to the root. With none, it is the nearest one a check entry for C sets, in any file. With none, it is the lens's declared default ceiling. With none, there is no ceiling.
5. **The result is the lesser of the requirement and the ceiling.** A ceiling can only lower. A rule's ceiling replaces its check's.
6. **The caps apply last**, as [Trust](#trust) lists them.

To let a capped lens block in one folder, that folder sets the ceiling for that check or rule itself. Writing a stricter table there is not enough, and `melian doctor` says so.

Two things follow that a reader should expect:

- A lens's declared mapping is weak. Any file on the walk that writes that severity beats it, and most roots write the whole table. A lens that must stay quiet declares a ceiling.
- A nearer check ceiling does not lift a rule ceiling set farther away. The folder restates the rule's ceiling to lift it.

A user's preference files layer over every committed file today, in a review of the working tree. They come first on the walk.

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
  checks:
    lens.cleanup: { ceiling: acknowledge }
```

One worked finding: `trust-boundary` reports `terminal-escape` at P1 in `services/payments/src/log.ts`.

1. The walk starts at the payments file. It has no rule entry for `terminal-escape` and no check entry for `lens.trust-boundary`. Its table writes `P1: block`. That file decides: the requirement is `block`.
2. The root's rule entry, `P1: acknowledge`, is never reached.
3. No file sets a ceiling for the rule or for `lens.trust-boundary`, and the lens declares none.
4. The result is `block`.

The same finding in `docs/guide.md` walks straight to the root. The root's rule entry maps P1, so the result is `acknowledge`.

A second finding shows the ceiling: `cleanup` reports `reuse` at P2 in `services/payments/src/ledger.ts`. The payments file maps no P2, so the walk reaches the root, whose table writes `P2: acknowledge`. The nearest check ceiling is the payments file's `acknowledge`. The result is `acknowledge`. In `docs/` the ceiling is the root's `advisory`, and so is the result.

Had the payments file written `P2: block` and no ceiling, the requirement would be `block` and the root's ceiling would still hold it at `advisory`. `melian doctor` lists that case.

## Merged defects

One defect can carry reports from several checks. Every member claim resolves under its own check, rule, severity, and path. The defect takes the strictest requirement among them. So a blocking `static.biome` report merged with an advisory lens report still blocks, whichever speaks for the defect and whatever `ruleAliases` says.

## Deterministic checks

Biome, tsc, Enola's rules, and guardrails resolve through the same keys. `static.biome`, `static.tsc`, `static.enola`, and `guardrails` are check names like any lens's. `static.mutation` joins them once step 16 lands, under whatever name it merges with. The `severity` keys those checks have today still set severity. These keys set what a severity requires.

Guardrail findings need one addition. Today every guardrail finding carries the guardrail's ID and no more: `guardrail/forbidden-paths`, `guardrail/required-files`, `guardrail/forbidden-patterns`, or `guardrail/policy-change-review`. Every `forbidden-patterns` rule, `focused-test` and `dynamic-import` alike, reports under the one ID. A line that several rules match is one finding at the strictest severity. The rule's own name appears only in the finding's prose. `guardrail/policy-change-review` carries two classes under one ID, a policy file and an analyser's configuration, each with its own severity.

So the keys under `resolution.checks.guardrails.rules` are:

- `guardrail/<name>`, for a whole guardrail. Today's findings can be keyed this way.
- `guardrail/<name>/<rule>`, for one configured rule, such as `guardrail/forbidden-patterns/focused-test`.
- `guardrail/policy-change-review/policy` and `guardrail/policy-change-review/analyser`, for the two classes.

For the last two forms, the step adds a typed field to a guardrail finding: the names of the configured rules that matched, or the notice's class. The field stays outside the finding's ID, so no stored finding changes identity. Within one file the named rule's entry comes before the guardrail's. A finding several rules matched resolves under each and takes the strictest.

## Trust

What is true today:

- Every `melian.yaml` is a policy file, and `policy-change-review` reports a change to one. That guardrail is forced on for the root file only. A nested file is judged under the configuration of the directory above it, and a base file there may switch the guardrail off.
- A notice on a file named `melian.yaml` never resolves below `acknowledge`. A notice on any other policy file, a `LENS.md` among them, has no such floor.

What step 18 adds:

- A change to any `resolution` key in any `melian.yaml` always draws the notice, wherever the file sits and whatever switch the directory above sets.
- A change to a lens's declared `resolution` in any `LENS.md` always draws it too.
- Neither notice resolves below `acknowledge`. None of the new keys can lower it: no mapping and no ceiling under `guardrails` applies to it.
- Melian compares the parsed `resolution` value at the base and at the head with its own loaders. A side that does not parse counts as changed.

The policy source stays the base for a pull request. A head that lowers its own lens's ceiling is reviewed under the base's keys, so it cannot lower its own findings. A lens's declared default is read from the same source as the lens.

The caps that apply after resolution, all of them:

- a `pre-existing` finding is never above `advisory`;
- an `affected` finding with no proving `cause` location is never above `advisory`;
- a lens finding no verifier judged is never above `advisory`;
- a policy-change notice on a `melian.yaml` is never below `acknowledge`, and from step 18 the two notices above share that floor.

[Resolution ownership](2026-10-03-resolution-ownership.md) stands. A lens declares a default, which is configuration that travels with the lens. Configuration and adjudication still decide. No tool and no lens writes a finding's resolution, and `report_finding` still stores none.

## Diagnostics

One finding's requirement can now come from several places, so the step builds two diagnostics.

- `melian findings` names the layer and the file that decided each finding's requirement, and the layer and file of its ceiling.
- `melian doctor` lists, for each folder that writes a table, every inherited ceiling that keeps a check or rule below what that table asks.

## Goldens

They live under `packages/evals/goldens/`, scripted, with no model, beside unit tests in core for each rule of the precedence.

- a rule entry beats its check's, within one file;
- a check entry beats the file's table;
- the nearest table beats a root rule entry;
- an inherited ceiling still caps a nearer table, with its doctor line;
- a lens's default mapping applies under a file that does not write that severity;
- a rule mapping is capped by its check's ceiling;
- a rule's ceiling replaces its check's;
- a ceiling lowers and never raises;
- a deterministic rule resolves through the keys, and a configured guardrail rule under its own name;
- a merged defect with opposite policies, in both speaker orders, and with a speaker `ruleAliases` chose;
- a finding the verifier lowered resolves under the lowered severity;
- a head that edits the keys is judged under the base;
- a `resolution` change in a nested `melian.yaml` whose parent switches the review off still draws a notice at `acknowledge`;
- a change to a `LENS.md` declared resolution draws one too, and a `guardrails` ceiling of `advisory` lowers neither.

What this gives up: resolution no longer reads one merged configuration. It needs each file's own layer, which the loader holds and `Finding.resolve` does not yet take. The nearest-file rule also means a root cannot force a rule's mapping on a folder that writes its own table. The table already works that way today. A root can still cap, because a ceiling inherits.

This extends [the resolution decision](2026-10-03-resolution.md) and [per-rule guardrail severity](2026-10-05-per-rule-guardrail-severity.md), and replaces neither: models still advise, and configuration still decides.
