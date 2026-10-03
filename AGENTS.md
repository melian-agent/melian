# Working in Melian

Read [docs/design.md](docs/design.md) before changing anything. It holds the decisions and the reasons for them. If you change a decision, change the document in the same commit.

## Conventions

- Follow Pi's conventions wherever Melian has no reason to differ: Node 22.19 or later, ESM only, TypeScript, npm workspaces, Biome for lint and format, Vitest for tests, TypeBox for schemas, exact-pinned direct dependencies.
- Prose uses Australian English. Code and identifiers use US English, matching the ecosystem.
- Plain, direct technical prose. No emojis in commits, issues, pull requests, or code. Explain non-trivial designs as problem, concrete example, then solution.
- Never commit unless the user asks.

## Lessons live here, not in agent memory

When you learn something non-obvious while working on Melian, a trap, a contract, a verification technique that actually works, record it in this repository as part of the same change: in this file, in `docs/`, or in the closest relevant document. Agent memory is private and goes stale. The repository is reviewed and inherited by everyone who touches it.
