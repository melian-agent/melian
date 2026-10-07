# Omit oversized imports from root carriers

[Pull request #85](https://github.com/melian-agent/melian/pull/85), fourth fix pass, finding 81c6fdcbf556ed7e. A root AGENTS.md importing a 300 KiB docs/rules.md made forFiles throw a root-carrier size error. The reader now distinguishes carriers from imports. Only an oversized root carrier remains fatal; an oversized import becomes a named omission.

The regression fails on both sources before the fix. After the fix, both readings retain AGENTS.md and the other standards, name docs/rules.md as oversized and omit it. Existing tests retain the fatal root-carrier exception. This implements the [oversized carrier decision](../decisions/2026-10-06-oversized-standards-carriers.md).
