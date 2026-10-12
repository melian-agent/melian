# Resolution is configurable per lens and per rule, per folder

Status: planned for milestone 2, step 18, "Resolution per lens and per rule". Nothing here is built, and no key below exists yet.

Problem: a folder's `melian.yaml` maps each severity to `block`, `acknowledge`, `advisory`, or `silent`, and that one table serves every check. A team cannot say that one lens only advises in one folder, or that one rule blocks in another. The only levers are the whole table and switching a lens off.

Example: a cleanup lens reports a reuse finding at P2. The folder's table says P2 needs an acknowledgement, which suits a correctness finding. For a cleanup finding it is too much, so the team either lowers P2 for every lens or disables the cleanup lens. A payments service wants the reverse for one rule: a terminal escape in its logs should block, while the rest of the repository keeps the default.

Choice: two more specific layers sit over the severity table. A rule's setting beats its check's, which beats the folder's table. A lens may declare a default of its own. Each layer may map severities and may set a ceiling.

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
        biome/suspicious/noExplicitAny: { P2: advisory, ceiling: advisory }
```

- `resolution.checks` is keyed by check name, as a tier spells it: `lens.<name>`, `static.<tool>`, or `guardrails`.
- An entry may map any of `P0` to `P3` and `nit`, and may set `ceiling`. Both take `block`, `acknowledge`, `advisory`, or `silent`.
- An entry's `rules` is keyed by rule ID, as the check's findings carry it. A rule entry takes the same mapping and `ceiling`.
- A rule sits under its check, because two lenses may share a rule ID.

A lens declares its default in its `LENS.md` front matter, in the same shape without `rules`:

```yaml
resolution: { ceiling: advisory }
```

## Precedence

Layering comes first. Every `melian.yaml` from the finding's path up to the root merges, nearest first, key by key, as every other setting does. That gives one effective `resolution` for the path. Then, for a finding at severity S from check C under rule R:

1. The requirement is the first of these that maps S: the entry for R under C, the entry for C, the lens's declared default, the folder's table.
2. The ceiling is the first of these that sets one: the entry for R, the entry for C, the lens's declared default. With none, there is no ceiling.
3. The result is the lesser of the requirement and the ceiling.
4. The caps that exist today still apply after that. A `pre-existing` finding and a lens finding no verifier judged stay at advisory or below. A policy-change notice on a `melian.yaml` never falls below `acknowledge`, whatever these keys say.

A ceiling can only lower. A rule's ceiling replaces its check's, so a folder that wants one rule above its lens's ceiling sets that rule's own.

One trap follows from the order. Specific beats general before near beats far. A rule entry in the root file beats the severity table of a nested file. A nested folder that wants otherwise restates the rule.

## An example with two folders

```yaml
# melian.yaml
resolution:
  P2: acknowledge
  checks:
    lens.cleanup: { ceiling: advisory }

# services/payments/melian.yaml
resolution:
  P2: block
  checks:
    lens.cleanup: { ceiling: acknowledge }
    lens.trust-boundary:
      rules:
        terminal-escape: { P2: block, P3: acknowledge }
```

One worked finding: `cleanup` reports `reuse` at P2 in `services/payments/src/ledger.ts`.

1. Layering: the payments file is nearer, so the effective table maps P2 to `block`, and the effective ceiling for `lens.cleanup` is `acknowledge`.
2. The requirement: no entry for `reuse` exists. The entry for `lens.cleanup` maps no severity. The lens's default maps none. The table maps P2 to `block`.
3. The ceiling: no rule entry sets one. The entry for `lens.cleanup` sets `acknowledge`.
4. The result is `acknowledge`, the lesser of the two.

The same finding in `docs/guide.md` resolves under the root alone: the table gives `acknowledge`, the ceiling is `advisory`, and the result is `advisory`.

## Deterministic checks

Biome, tsc, Enola's rules, mutation findings, and guardrails resolve through the same keys. `static.biome`, `static.tsc`, `static.enola`, `static.mutation`, and `guardrails` are check names like any lens's. The `severity` keys those checks have today still set severity. These keys set what a severity requires.

## Trust

Any change to these keys in a `melian.yaml` is a policy change. It draws the policy-change notice, as every change to a `melian.yaml` does, and that notice never resolves below `acknowledge`. The policy source stays the base for a pull request. A head that lowers its own lens's ceiling is reviewed under the base's keys, so it cannot lower its own findings. A lens's declared default is read from the same source as the lens.

What this gives up: one finding's requirement now depends on up to four places. `melian findings` must say which layer decided, or a maintainer cannot tell why a finding did not block. The step builds that line.

The step's goldens:

- a rule entry that beats its check's;
- a check entry that beats the table;
- a lens default under a folder's override;
- a ceiling that lowers and never raises;
- a root rule entry against a nested table;
- a deterministic rule resolved through the keys;
- a head that edits the keys and is judged under the base.

This extends [the resolution decision](2026-10-03-resolution.md) and [per-rule guardrail severity](2026-10-05-per-rule-guardrail-severity.md), and replaces neither: models still advise, and configuration still decides.
