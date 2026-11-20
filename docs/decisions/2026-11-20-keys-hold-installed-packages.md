# Request keys hold the installed packages their producer runs

Amends: [A producer's code version comes from recorded module hashes](2026-11-18-code-versions-from-recorded-hashes.md), "How it is built" and "What it gives up", whose sentences that installed packages are left out, since the lockfile pins them, this replaces

Amends: [The checks' code version comes from recorded module hashes](2026-11-20-check-code-from-recorded-hashes.md), "The change", which now holds the checks' packages beside their code

Amends: [A lens run offered `list_mutants` keys the instrumenter that answers it](2026-11-16-lens-request-keys-the-mutant-instrumenter.md), whose key held the instrumenter's version but not its dependencies

Amends: [A lens run is reused by its request key, one lens at a time](2026-11-15-lens-runs-reused-per-request.md), whose key held the versions of Pi Durable and pi-ai alone

Status: the coordinator chose this approach on 2026-11-20, in its session, on [issue #470](https://github.com/melian-agent/melian/issues/470): one identity per producer, the two exclusions, and the checks' and adjudication's own packages in this issue. Those are the coordinator's choices, not a maintainer's ruling.

## Problem

A request key held the versions of Pi Durable and pi-ai, and of the instrumenter for a run offered `list_mutants`, but none of the packages beneath them. The checks' and adjudication's keys held no installed package at all. Those packages resolve through caret ranges, so an `npm update`, or a fresh install on another day, moves them under the same Melian release.

Example: pi-ai turns a conversation into a provider's request through the OpenAI client beneath it. A reinstall that moves that client from 7.19.0 to 7.20.0 leaves pi-ai at 1.1.0, so a repeat review reuses a lens run another request built. A newer `yaml` can read a `melian.yaml` differently under the same `codeVersion("checks")`, and a repeat review reuses a guardrails run the old parser decided.

## The change

Each producer keys `packages`, a digest of every installed package beneath the packages its code imports.

| Producer | Roots | Where the digest sits |
|---|---|---|
| lens run | pi-ai and Pi Durable, resolved from the pipeline package | `packages` in the lens request, in place of the two versions |
| lens run offered `list_mutants` | `@stryker-mutator/instrumenter`, from whichever install `TypeScriptMutationAdapter.open` chose | `mutants.packages` beside its version and source |
| checks | what the modules `checks.ts` reaches import as they load | `packages` in the check request, beside `code` |
| adjudication | what the modules `adjudication.ts` reaches import as they load | `packages` in the task's input, beside `code` |

Node's resolver is the authority twice over.

- **Which packages a producer imports.** `scripts/code-hashes.mjs` loads each producer's entry in a child process with a resolve hook, and records every installed package a module outside any install imports, under the package that imports it. TypeScript's listing can't answer this: it names `@types/semver` for `semver`, and a type-only import that never runs. The record sits in `code-hashes.ts` beside the module hashes, and the gate fails, naming the producer and the import, when it differs from what Node resolves.
- **Which copy is installed.** At run time, `installedPackages` starts from each recorded import and resolves it with `findPackageJSON` from the manifest of the package that imports it. It then reads each manifest's `dependencies`, `optionalDependencies` and `peerDependencies`, and resolves each from that manifest's real path, as Node does without `--preserve-symlinks`. The walk of pi-ai and Pi Durable here matched `npm query` exactly and takes about 20 ms; each set is read once a process.

The digest is a SHA-256 over sorted lines, each ended by a newline. Each installed copy the walk reaches reads as `place name@version`. `place` is the copy's real directory relative to the install root, with `/` between its parts on every platform. The install root is the deepest directory that holds the outermost `node_modules` of every root: the checkout for a clone, the global prefix's `lib` for a global install. Every root decides it, not the first: npm can nest one root beneath a workspace package, at `packages/pipeline/node_modules`, and hoist the next to the checkout's `node_modules`, and a root taken from the first alone put the second outside the install, which Codex's fourth review found. Node finds a package only in a `node_modules` above the file that imports it, so the root holds every importer's lookups. A declared peer that does not resolve reads as `name absent, a peer of parent@version`, so an optional peer that appears, such as `undici` beneath `openai`, moves the digest.

Node resolves an import by walking up from the importing file's real directory to the nearest `node_modules` that holds the name. So the place of every copy fixes which copy each import reaches, and the digest needs no line for who resolves what. Two earlier forms collided, and each collision is a named test in `installed-packages.test.ts`. A set of releases alone collided: `a` resolving `parser@1.1` and `b` resolving `parser@1.2`, or the reverse, which Codex's second adversarial review found. Lines of `parent > name@version` collided when two copies of one release of `a` sat at two places and swapped which `parser` each resolved, which Codex's third review found. The coordinator chose the layout on 2026-11-20, over a fourth form that named each copy by its chain of parents.

**The guarantee:** two installs with one digest resolve every reached import to the same release. A test falsifies it by building two layouts that give one digest and resolve some import differently.

**What it gives up:** two installs that resolve every import alike but place a copy differently key apart, and that miss reruns. A dedupe that moves `sdk` from `tool/node_modules` up to `node_modules`, with no release changed, asks every lens again once.

**Across hosts.** A record shared between a host and an Actions runner is reused only if both give one digest. `npm ci` installs the layout `package-lock.json` records: a version 2 or 3 lockfile names every copy by its install path, so the algorithm npm hoists with does not decide it. One lockfile installed with `npm ci` by npm 11.19.0 in one directory and by npm 10.9.2 in another, three directories deep elsewhere, gave one digest over 42 copies beneath `@babel/core`, `debug` and `ms`. So did `npm install` with no lockfile, by npm 10.9.2. Two cases still key apart: a version 1 lockfile, which records no paths, so npm hoists it afresh; and a platform build a parent names by a range, which a host whose platform npm refuses does not install. A workspace package reached through `node_modules/<name>`, a link to the checkout's `packages/<name>`, reads at its real place, `packages/<name>`, and its own dependencies resolve from there.

**Separators.** `place` joins its parts with `/`, so a Windows install and a POSIX one of the same layout give one digest. No Windows host or CI job runs here, so the test of the join runs only on POSIX, where it is a no-op.

A copy whose real directory is outside the install root, such as a link to a directory elsewhere, fails the key, naming it: its place would name the host. So does a root Node finds beneath no `node_modules`, such as a package importing its own name.

A producer is keyed by its own set, so a move beneath the instrumenter asks only the tests lens again, and a move in `yaml` reruns only the checks and adjudication, which spend no tokens.

## Failing closed

A root, or a required dependency, that does not resolve fails the key with the package's name and who needs it: "Melian cannot find the installed package sdk, which pi@1.1.0 needs." So does a manifest that is not JSON, names another package, or gives no version. The key never holds an empty or partial list. An adjudication task whose `packages` differs from the running install's fails, as one with another build's `code` does, and decides nothing.

`packages` takes no task version. The task has no input schema, so a build reads an unknown field without complaint. Any build that does not know the field also has other adjudication code, so its `code` check fails the task before the field matters, and the next review decides again. Run against main's own code at 56f7fb059, a pending task this build wrote failed with "another build's adjudication code created this task", and made no model call. The other direction is a test: `adjudication-key-reopen.test.ts` reopens a version 8 task that main's own code left pending, from `fixtures/adjudication-key-main/pending-8.sqlite`. It fails, and the next review decides again with no model call.

## What it leaves out, and what that gives up

- **`@types/*`.** It never runs.
- **Platform builds.** A package whose manifest declares `os` or `cpu`, and whose parent names the exact version installed, is left out with what it needs. So is an optional dependency that does not resolve, which npm skips for a platform it refuses. Keyed, a record shared across hosts would never reuse a run made on another platform. The parent's exact pin stands for its builds: `esbuild@0.28.2` names `@esbuild/linux-x64` as `0.28.2`, and `typescript@7.0.2` names `@typescript/typescript-linux-x64` as `7.0.2`, the only two such packages these sets reach. A platform build named by a range, or imported by a producer itself, is keyed like any other package, since nothing else fixes its version; Codex's adversarial review found that case. Each resolution decides for itself, so the exact pin's resolution is left out and a ranged one keys the copy, whichever the walk meets first; Melian's own round found the first rule depended on that order. This gives up a platform build whose contents differ under the same version, and an optional dependency whose install failed, which reads like one the platform refused.
- **An undeclared import.** A package that imports one its manifest does not declare, relying on hoisting, is missed. The walk can't see that edge without loading the module.
- **The instrumenter beneath the checks.** The checks reach the mutation code, which resolves the instrumenter at run time, not by import, so the checks' set does not hold it. `static.mutation` keys Stryker's own installation.

## Melian's own packages

The digest holds no Melian package. A producer's code version hashes the source of every module it reaches, `packages/core/src` included, so in a checkout the code version covers them. A published install is another matter. Each workspace package named the others as `"*"`, so a fresh install could pair `@melian-agent/pipeline` 1.0, whose recorded code version is a constant from its build, with `@melian-agent/core` 1.1. The checks and adjudication keys would then match runs made under the old core. Melian's own round at c6acaadb5 found it.

Each workspace package now names the others at their exact version, as AGENTS.md already asks of every direct dependency. A release of the pipeline then fixes which core and decisions it runs, and its recorded code version covers them. `scripts/check-pinned-deps.mjs` used to let `"*"` through for a workspace name, on purpose, since npm links it locally either way; it now fails any workspace dependency that is not that package's own version. **A release must bump every workspace package in lockstep**, and update each package's dependencies on the others in the same commit, or the gate fails.

## What it costs

Every stored lens run, check run and adjudication misses once. A lens run costs tokens, about $5 a full round here; a check run costs minutes and no tokens; an adjudication costs no model call. After that, a set moves only when an install moves a package in it. In this repository, `package-lock.json` changed in 21 of the 303 first-parent commits on `main` since 2026-10-03; four moved the model request set, two of them with Pi itself, and two moved the instrumenter's.
