# A whole-guardrail entry in a nearer file speaks for a named rule's finding

A whole-guardrail entry in a nearer file speaks for a named rule's finding. The root maps the rule `focused-test` to `block`. The file in `tests/` sets a ceiling for the whole `forbidden-patterns` guardrail, which is a check-level entry for every finding of it. The focused test under `tests/` is therefore advisory, and the root's rule entry no longer applies there.
