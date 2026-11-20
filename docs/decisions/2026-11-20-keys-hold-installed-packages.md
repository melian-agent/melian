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
- **Which copy is installed.** At run time, `installedPackages` starts from each recorded import and resolves it with `findPackageJSON` from the manifest of the package that imports it. It then reads each manifest's `dependencies`, `optionalDependencies` and `peerDependencies`, and resolves each from that manifest. The walk of pi-ai and Pi Durable here matched `npm query` exactly and takes about 20 ms; each set is read once a process.

The digest is a SHA-256 over sorted lines, each ended by a newline. A package reads as `name@version`. Each resolution reads as `parent > name@version`, where a root's parent is the workspace package that imports it, so two installs of the same releases that resolve them differently differ. Codex's second adversarial review found that a set of releases alone collides: `a` resolving `parser@1.1` and `b` resolving `parser@1.2`, or the reverse. The coordinator agreed on 2026-11-20. A declared peer that does not resolve reads as `name absent, a peer of parent@version`, so an optional peer that appears, such as `undici` beneath `openai`, moves the digest.

A producer is keyed by its own set, so a move beneath the instrumenter asks only the tests lens again, and a move in `yaml` reruns only the checks and adjudication, which spend no tokens.

## Failing closed

A root, or a required dependency, that does not resolve fails the key with the package's name and who needs it: "Melian cannot find the installed package sdk, which pi@1.1.0 needs." So does a manifest that is not JSON, names another package, or gives no version. The key never holds an empty or partial list. An adjudication task whose `packages` differs from the running install's fails, as one with another build's `code` does, and decides nothing.

`packages` takes no task version. The task has no input schema, so a build reads an unknown field without complaint. Any build that does not know the field also has other adjudication code, so its `code` check fails the task before the field matters, and the next review decides again. Run against main's own code at 56f7fb059, a pending task this build wrote failed with "another build's adjudication code created this task", and made no model call. The other direction is a test: `adjudication-key-reopen.test.ts` reopens a version 8 task that main's own code left pending, from `fixtures/adjudication-key-main/pending-8.sqlite`. It fails, and the next review decides again with no model call.

## What it leaves out, and what that gives up

- **`@types/*`.** It never runs.
- **Platform builds.** A package whose manifest declares `os` or `cpu`, and whose parent names the exact version installed, is left out with what it needs. So is an optional dependency that does not resolve, which npm skips for a platform it refuses. Keyed, a record shared across hosts would never reuse a run made on another platform. The parent's exact pin stands for its builds: `esbuild@0.28.2` names `@esbuild/linux-x64` as `0.28.2`, and `typescript@7.0.2` names `@typescript/typescript-linux-x64` as `7.0.2`, the only two such packages these sets reach. A platform build named by a range, or imported by a producer itself, is keyed like any other package, since nothing else fixes its version; Codex's adversarial review found that case. Each resolution decides for itself, so the exact pin's resolution is left out and the others are keyed, whichever the walk meets first; Melian's own round found the first rule depended on that order. This gives up a platform build whose contents differ under the same version, and an optional dependency whose install failed, which reads like one the platform refused.
- **An undeclared import.** A package that imports one its manifest does not declare, relying on hoisting, is missed. The walk can't see that edge without loading the module.
- **The instrumenter beneath the checks.** The checks reach the mutation code, which resolves the instrumenter at run time, not by import, so the checks' set does not hold it. `static.mutation` keys Stryker's own installation.

## What it costs

Every stored lens run, check run and adjudication misses once. A lens run costs tokens, about $5 a full round here; a check run costs minutes and no tokens; an adjudication costs no model call. After that, a set moves only when an install moves a package in it. In this repository, `package-lock.json` changed in 21 of the 303 first-parent commits on `main` since 2026-10-03; four moved the model request set, two of them with Pi itself, and two moved the instrumenter's.
