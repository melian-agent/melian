# 2026-10-25: clean goldens for rules 2 to 4 of high signal, low noise

Codex's review of [pull request #214](https://github.com/melian-agent/melian/pull/214) at `42b7068b` found that the clean goldens covered rule 1 only. Three new clean goldens give each other rule a head whose output follows it, shaped as close as possible to the positive case so the rule decides alone:

- `design-contradicts-documented-decision-diagnostic-clean`: caller notes stay in the ledger, and the comment gains the one allowed line saying no lens saw callers.
- `design-contradicts-documented-decision-surface-clean`: the ledger gains the round's diagnostic notes, which that surface allows, and the status stays plain.
- `design-contradicts-documented-decision-collapse-clean`: the checks that did not run stay open, and the advisories collapse under a count and a noun.

Each fixture's behaviour is pinned in `packages/evals/test/design-fixtures.test.ts`. Codex also noted that scripted verifier verdicts prove the plumbing only. The scripted runs here show that the plumbing holds; they are not evidence that the rule stays quiet. The coordinator measures that with live passes.
