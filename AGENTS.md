# Working in Melian

Read [docs/design.md](docs/design.md) before changing anything. It holds the decisions and the reasons for them. If you change a decision, change the document in the same commit. [docs/design-implementation-plan.md](docs/design-implementation-plan.md) tracks what is built and what is deferred; update its status and progress log in the same commit as the work.

Melian is a TypeScript monorepo built on Pi Durable. It follows Pi's conventions wherever it has no reason to differ, so a contributor moving between the two repositories finds nothing surprising.

## Guidance files

Root `AGENTS.md` covers cross-cutting material: style, workflow, commits, and review. Package-level `AGENTS.md` files arrive with the first domain code in each package. Each imports the guideline for its package from `docs/guidelines/`, so an agent working in one package loads only what it needs. Every `AGENTS.md` has a one-line `CLAUDE.md` beside it containing `@AGENTS.md`, so Claude Code and other agents read the same instructions.

Before designing or planning a change, read the guideline for every layer involved. Do not rely on defaults.

## Writing rules

For chat, comments, docs, commit messages, and anything an author will read, follow the principles of Zinsser's *On Writing Well*:

- Cut every word that is not doing work. Watch for "really", "very", "quite", "in order to", "the fact that".
- Prefer short words and short sentences. If a sentence runs past about 25 words, find the seam.
- Use active verbs and name who did what. Passive voice only when the actor does not matter.
- Use concrete words and specific examples. "Three callers" beats "several places".
- Cut hedges and throat-clearing. State the claim. Start with the thing itself.
- No jargon, clichés, or corporate-speak. No emojis in commits, issues, pull requests, or code.
- One thought per sentence, one idea per paragraph. Trust the reader; do not restate or pre-summarise.
- Explain non-trivial designs and problems as problem, concrete example, then solution. Say why the solution is necessary and separate it from optional complexity.
- Prose uses Australian English. Code and identifiers use US English, matching the ecosystem.
- Link every GitHub issue and pull request you mention, in chat and docs. Only GitHub's own UI turns a bare number into a link.

## Code

- The default is no comment. A comment earns its place by carrying what the code cannot: a non-obvious why, a constraint from outside the file, or a trap that reads like a mistake. If it restates the code or narrates the line below, delete it.
- Assume one line is enough. A comment block is for the rare decision that needs a paragraph. Explaining your reasoning is for the pull request and the chat, not the source file.
- TSDoc only on exported package API. Nothing on internals.
- Good code communicates intent. Reach for a better name or a smaller function before reaching for an explanation.
- No `any` unless there is no alternative. Top-level imports only; no `await import()` or `import("pkg").Type`.
- Use only erasable TypeScript syntax: no parameter properties, `enum`, `namespace`, `import =`, or `export =`. Explicit fields with constructor assignments.
- Inline single-line helpers that have one call site.
- Check `node_modules` for external API types; do not guess. Never remove or downgrade code to fix a type error from an outdated dependency; upgrade the dependency.
- Direct dependencies are pinned to exact versions. Treat dependency and lockfile changes as reviewed code, and read the lockfile diff rather than the pull request title.
- Every Melian capability must be reachable from the `melian` CLI, because the skills for Claude Code, Codex, and Pi only ever call the CLI.
- A repeated review finding becomes a check: a lint rule, a guardrail, or a lens test, with a grandfather list that shrinks as offenders are fixed.
- Always ask before removing functionality that appears intentional.

## Validation

There is one gate: `npm run check`. It runs Biome, type checking, dependency audit, and tests. Run it before completing any development work and fix everything it reports, including findings that look unrelated to your change.

Do not pipe test or check output through `tail`, `head`, or `cat`. Without `pipefail`, a pipeline reports the last command's status, so `npm run check | tail` exits 0 even when the check failed, and the failure scrolls past above the summary. Redirect to a file and read that, or run the command directly.

If you create or modify a test, run it and iterate until it passes. Tests use Vitest and Pi Durable's memory storage; never real providers, keys, or paid tokens.

## Commits and pull requests

- Commit each discrete change as soon as it is complete and verified, before starting the next separable piece of work. Do not let two separable changes accumulate in the working tree; splitting them afterwards is error-prone. If you are on `main`, branch first.
- Conventional commits, concise. Say what value the commit creates, not a catalogue of changes.
- One pull request per issue. Stack commits inside it; do not stack pull requests for one piece of work.
- Run a code review on the branch diff before opening a pull request, and land each fix as its own commit.
- After opening, track CI, read every review comment, and commit each fix separately. Check for fresh comments after each push.
- Update documentation in the same change whenever behaviour diverges from what is documented.
- Do not publish online artifacts for project deliverables such as reports, audits, or plans. Write them under `tmp/` or another agreed location and give the file path.

## Agents and the working tree

A delegated agent shares your checkout. Do not `git checkout`, `git pull`, `git stash`, or rebase in the orchestrating session while one is working. Use a throwaway worktree for concurrent work on another branch. Read-only agents are safe to overlap; writers are not.

## Lessons live here, not in agent memory

When you learn something non-obvious while working on Melian, such as a trap, a contract, a tooling gotcha, or a verification technique that actually works, record it in this repository as part of the same change: in this file, in `docs/`, or in the closest relevant document. Agent memory is private and goes stale. The repository is reviewed and inherited by everyone who touches it.

## Learnings

Add important learnings here, newest last. Each entry names the symptom, the cause, and what to do.

- `npm install` fails with `ETARGET ... No matching version found for <pkg>@<version> with a date before <date>`, or with `ERESOLVE ... Found: <pkg>@undefined`. Cause: `.npmrc` sets `min-release-age=2`, so npm hides releases younger than two days. Pick the newest release older than that, or wait. To take a fresh release anyway, pass `--min-release-age=0` to that one install, never in `.npmrc`, and check the lockfile for anything else younger than two days. `npm ci` installs from the lockfile and does not apply the check, so a lockfile generated with `--min-release-age=0` would pass CI unchanged. `scripts/check-release-age.mjs`, part of `npm run check`, enforces the window instead: it looks up the publish time of every registry entry in `package-lock.json` and fails on anything younger than the `.npmrc` setting, or that resolves outside the npm registry, where it cannot read a publish date. To take a fresh release, add it to `.release-age-exceptions.json` with a reason; an exception that has aged out is harmless. Only npm 11.10.0 or later reads `min-release-age`; npm 10, bundled with every Node 22 release, ignores it without a warning. The root `engines` field and `engine-strict=true` make older npm refuse to install, so on Node 22 run `npm install -g npm@11.19.0` first, as CI does.
- `npm ci` fails with `EBADENGINE ... Not compatible with your version of node/npm: <pkg>`. Cause: `engine-strict=true` applies every dependency's `engines` field, not only the root's, and some dependencies exclude odd-numbered Node releases (Vitest 5 rejects Node 25). Use Node 22, 24, or 26, the versions CI runs; the two LTS lines plus the current line.
- `npm run build` fails with `TS2307: Cannot find module '@melian-agent/<pkg>'` while `npm run check` passes. Type checking resolves workspace packages from source; the build compiles each package against the declarations of the packages it references. Either the importing package's `tsconfig.build.json` does not list the imported package in `references`, or a `dist` directory was deleted by hand and the `tsconfig.build.tsbuildinfo` beside it told `tsc -b` that nothing needed rebuilding. Add the reference, or run `npm run clean`, which deletes both.
