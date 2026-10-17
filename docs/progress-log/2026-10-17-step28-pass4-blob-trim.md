# Step 28 pass 4: exact Git trim mutants

[Pull request 142](https://github.com/melian-agent/melian/pull/142).

The host mutants remove `.trim()`. Pass 3 swapped streams, which is a different mutation.
The stderr test now includes surrounding whitespace and fails when trimming is removed.
It imports guardrails directly so Vitest can relate it to the mutated source.

The stdout mutant is equivalent for Git's object-ID output: snippetHash already normalises whitespace.
The inventory and evidence are in `tmp/step28-phase2-mutations.md` and `tmp/step28-equivalents.md`.
No production behaviour or plan status changed.
