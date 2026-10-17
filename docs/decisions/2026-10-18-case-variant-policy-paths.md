# Policy classifiers recognise case variants

Supersedes: none.

This clarifies the [nested policy rule](2026-10-18-nested-policy-exact-rule.md) for
[pull request #147](https://github.com/melian-agent/melian/pull/147).

A case-insensitive filesystem can open `.Agents/Lenses/correctness/lens.md` through the loader's canonical path.
Case-sensitive classification lets that lens narrow review beneath a parent that disabled notices, without acknowledgement.

Classify `.melian`, `.agents`, `lenses` and `LENS.md` case-insensitively.
Apply the same rule to policy membership beneath `.melian`, analyser paths and package-manifest checks.
The loader's scope scan recognises directory aliases too. It does not reject aliases or change reader lookups.
An alias marks a nearer scope only when the source can resolve the canonical lens file.
An unresolved alias must not remove a farther lens's coverage. Symlinked entries still reach the loader's refusal.
The scope and lens name retain their original spelling and identity. Configured globs retain their existing semantics.

Every changed lens blob still draws a notice with an acknowledgement floor, despite a disabled parent.
Git reads still use exact path spelling. Revision readers do not resolve aliases.
The nested policy rule's blob comparison, resolution protection, dismissal binding and accepted residual risks remain in force.
