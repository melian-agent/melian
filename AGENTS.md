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

If you create or modify a test, run it and iterate until it passes. Tests use Vitest and the fake model from the pipeline's testing entry, `@melian-agent/pipeline/testing`; never real providers, keys, or paid tokens. Use Pi Durable's memory storage unless the test is about surviving a reopen or a crash; then use SQLite in a temporary directory.

## Commits and pull requests

- Commit each discrete change as soon as it is complete and verified, before starting the next separable piece of work. Do not let two separable changes accumulate in the working tree; splitting them afterwards is error-prone. If you are on `main`, branch first.
- Conventional commits, concise. Say what value the commit creates, not a catalogue of changes.
- One pull request per issue; stack commits inside it. A pull request for a later step may be based on the previous step's unmerged branch, opened with `--base <that branch>` and retargeted as the stack lands, so work never waits on a merge.
- Run a code review on the branch diff before opening a pull request, and land each fix as its own commit.
- Open every pull request as a draft (`gh pr create --draft`). Mark it ready (`gh pr ready`) only after the external reviews are applied and CI passes on the result. A draft is never queued for merge; a ready pull request means the reviewer can merge without reading the review state.
- `main` uses a merge queue. Merge with "Merge when ready" or `gh pr merge --merge --auto`, which has GitHub test the merged result before landing it, so a stacked pull request never needs `main` merged into it by hand after its base lands. Branch protection does not require branches to be up to date.
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
- Vitest fails with `Cannot find module '.../node_modules/@earendil-works/chord/src/index.ts'` once a test imports a Pi package. Cause: Pi's packages publish a `source` export condition pointing at a `src/` directory they do not ship, and Vite applies a custom condition to every package it resolves, not only the workspace's. Melian's workspace packages use the condition `@melian-agent/source`, set in each `package.json`, `tsconfig.json`, and `vitest.config.ts`. Never name a custom condition something a dependency might also publish; namespace it with the npm scope.
- A Pi Durable test ends early because a scripted tool call never runs. Cause: pi-ai's `fauxAssistantMessage()` defaults to `stopReason: "stop"`, and the harness runs tool calls only from a reply that stopped with `"toolUse"`. Pass `{ stopReason: "toolUse" }` to every fake reply that calls a tool.
- A reviewer flags that a pull request changed a decision but left `docs/design.md` alone. Cause: a brief or plan told the work to propose design changes rather than make them, and that instruction overrode the rule at the top of this file. A pull request that changes a decision edits `docs/design.md` in the same pull request, whatever the brief says; a report may explain the change, but it does not replace it.
- On macOS, `tsc` fails with `TS1149 ... differs from already included file name ... only in casing` once one package imports another by name. Cause: the shell's working directory spells the checkout path in a different case from the disk, say `Dev/melian` for `dev/Melian`. `tsconfig.json`'s include globs use the shell's spelling, and the workspace symlink under `node_modules` resolves to the disk's, so tsc sees one file twice. Run `cd "$(pwd -P)"` first; it switches to the spelling on disk. Typing the right spelling is not enough: zsh keeps the old spelling when `cd` names the directory it is already in, so `cd ~/dev/Melian` from `~/Dev/melian` changes nothing.
- A test that spawns `node some-fixture.ts` imports a stale build of another workspace package, or fails with `Cannot find module '.../dist/index.js'` on a clean checkout. Cause: plain Node does not apply the `@melian-agent/source` condition that Vitest and tsc use, so a workspace import resolves to `dist`. Spawn the child with `--conditions=@melian-agent/source`, as `packages/pipeline/test/durable-spike.test.ts` does.
- `gh pr checks` says `no checks reported` after a push, and the pull request shows no runs. Cause: the check workflow runs on `pull_request`, and GitHub runs nothing for a pull request that conflicts with its base, because it cannot build the merge ref. `gh pr view --json mergeable` reads `CONFLICTING`. The merge queue only spares a stacked branch from merging `main` when there is no conflict; merge `main` in and resolve it, then push.
- A lens tool's result arrives cut, with no closing boundary tag and no "read again" note. Cause: Pi Durable cuts every tool result at 50 KB or 2000 lines, keeping the head, unless the tool sets `outputLimits`. Bound what the tool returns below that yourself and set `outputLimits` above your bound, as the lens tools in `packages/pipeline/src/lens-tools.ts` do.
- A `beforeTool` hook does not see a tool call replayed after a crash. Cause: Pi Durable runs hooks in the tool task's `call` phase, and a crash after the intent commit resumes in the `execute` phase, which reruns a replay-safe tool directly. The model's own retry of that call does pass through the hook. Keep a check that must hold on replay inside the tool's commit, as `report_finding`'s budget check is.
- A model gets a schema error such as `evidence: must be object` and does not know how to fix its call. Cause: Pi Durable validates arguments against the schema before any hook. A tool's `prepareArguments` runs before validation; throw there with a message saying what the argument must be, as `report_finding` does for prose evidence.
- `npm run check` fails in Biome with `Found a nested root configuration`, or `git add -A` warns about `adding embedded git repository`. Cause: another agent's git worktree sits inside the checkout, such as under `.claude/worktrees/`, with its own `biome.json`. Put worktrees beside the checkout, never inside it, and unstage an embedded repository with `git rm --cached <path>`. `.gitignore` lists `.claude/worktrees/`, where Claude Code puts agent worktrees, so `git add -A` no longer stages them; Biome still finds their `biome.json` if one sits inside the checkout.
- A gate run passes or fails for code you never touched, and its test count jumps. Cause: agents working in parallel worktrees can share one scratchpad directory, and a helper script with a common name, such as `gate.sh`, was overwritten by another agent and ran `npm run check` in that agent's worktree. Name scratch scripts and logs after your worktree, `cd` to an absolute path inside the script, and print the working directory with the result.
- `tsc` fails with `Type '{ items: Record<string, X> }' does not satisfy the constraint 'JsonObject'` on a `defineDoc`. Cause: Pi Durable requires a document's value to be JSON, and TypeScript never gives an `interface` the implicit index signature that `JsonObject` needs. Declare the stored shapes with `type` aliases, and use mutable arrays, since a `readonly` array is not a `JsonValue[]`.
- A `console.log` in a passing Vitest test prints nothing, so a quick reproduction looks silent. Run it with `npx vitest --run --silent=false <file>`.
- A test or eval that runs lenses on the fake model fails at random, one lens answered with another's reply. Cause: pi-ai's faux provider holds one response queue for the whole collection, and the lens task runs its conversations in parallel, so whichever lens asks first takes the next reply. Script each conversation with `scriptConversations()` from `@melian-agent/pipeline/testing`, which picks the reply by text in the request's system prompt.
- A test whose scripted reply is an error takes seconds and then fails with the wrong message. Cause: Pi Durable retries a failed model request with backoff by default. Open test harnesses with `settings: { retry: { enabled: false } }`.
- `waitForTask()` never resolves for a task created in a commit. Cause: no installed extension defines that task, so the scheduler leaves it `blocked` and waits for a registry change that never comes. Check `harness.inspect()` for a `blocked` state after creating the task, as `reviewChangeset` does, and open review harnesses with `openReviewHarness` or install `lensExtension`.
- A lens over `paths: ["**"]` misses `.github/workflows/ci.yml`. Cause: Node's `path.matchesGlob` does not let `**` or `*` match a name starting with a dot. Lens paths use core's own matcher in `src/glob.ts`, where `**` matches dotfiles; do not swap in `matchesGlob`. The matcher compiles with the `s` flag: git allows a newline in a file name, and a `.*` that stopped at one let a head name a file so that no lens reviewed it.
- Pi's credential store is `auth.json` in Pi's agent directory: `$PI_CODING_AGENT_DIR/auth.json`, or `~/.pi/agent/auth.json`. It is plain JSON, one credential per provider, `{ "type": "api_key", "key" }` or `{ "type": "oauth", "access", "refresh", "expires" }`, written with mode 0600; pi-ai's README documents the shape and Pi's `packages/coding-agent/src/core/auth-storage.ts` is the reference reader. Melian reads it and never writes it. An OAuth login that has expired, or falls inside pi-ai's five-minute refresh window plus two minutes, therefore reads as absent rather than refreshing: providers such as Anthropic rotate the refresh token, and a refresh Melian did not write back would leave Pi holding a dead one. pi-ai's `checkAuth` ignores expiry, so the store has to. A key Pi resolves at use, `!command` or containing `$`, reads as absent, so the provider's environment variable applies.
- A live eval run loaded from a `.env` file fails at once with `node: --env-file= is not allowed in NODE_OPTIONS`. Cause: Node refuses `--env-file` in `NODE_OPTIONS`, so `npm run eval:live` cannot take one. Run `npm run build`, then `node --env-file=<file> packages/evals/src/live.ts` with `MELIAN_EVAL_LIVE=1`; without the `@melian-agent/source` condition the workspace imports resolve to `dist`, which is why the build comes first. The flag keeps the credential out of the shell, its history, and the command line.
- `npx melian` asks the npm registry for a package named `melian`, or the shell says `permission denied`, after `npm ci` and a build. Cause: npm links a workspace package's `bin` only if the file exists at install time, and `npm ci` runs before any build, so a `bin` pointing into `dist/` is never linked; `tsc` also writes files without the executable bit. `packages/cli/bin/melian.js` is a committed, executable shim that imports `../dist/bin.js`. Point any new `bin` at a committed shim, never at `dist/`.
- Vitest or tsc fails with `Unterminated regular expression` on a line that looks whole, in a regex or string meant to match control characters. Cause: the file holds a literal U+2028 or U+2029, which JavaScript treats as a line break, because an editing tool wrote the character where the source said `\u2028`. Keep invisible and separator characters as `\uXXXX` escapes in source, and grep for them with `grep -nP '[\x{2028}\x{2029}\x{200b}]'` when a parse error makes no sense.
- A review or diff of a stacked pull request fails with `fatal: bad revision '<branch>...<head>'` after its parent merges. Cause: when the parent lands, GitHub retargets the child onto `main` and the parent's branch is deleted, so a command that names the old base by branch no longer resolves. Diff against `origin/main...<head>`, or read the current base with `gh pr view <number> --json baseRefName` first. The retarget also changes the diff with the head unchanged, which is why Melian keys a review by base and head together.
