# Request keys hold Melian's whole install

Amends: [A producer's code version comes from recorded module hashes](2026-11-18-code-versions-from-recorded-hashes.md), "How it is built" and "What it gives up", whose sentences that installed packages are left out, since the lockfile pins them, this replaces

Amends: [The checks' code version comes from recorded module hashes](2026-11-20-check-code-from-recorded-hashes.md), "The change", which now holds Melian's install beside the checks' code

Amends: [A lens run offered `list_mutants` keys the instrumenter that answers it](2026-11-16-lens-request-keys-the-mutant-instrumenter.md), whose key held the instrumenter's version but not the install it runs from

Amends: [A lens run is reused by its request key, one lens at a time](2026-11-15-lens-runs-reused-per-request.md), whose key held the versions of Pi Durable and pi-ai alone

Status: the coordinator chose this design on 2026-11-20, in its session, on [issue #470](https://github.com/melian-agent/melian/issues/470), after reviews found a new collision in each earlier form: one digest over the whole install, a fixed line and a flag for an install Melian cannot identify, and the bound. Those are the coordinator's choices, not a maintainer's ruling.

## Problem

A request key held the versions of Pi Durable and pi-ai, and of the instrumenter for a run offered `list_mutants`, but none of the packages beneath them. The checks' and adjudication's keys held no installed package at all. Those packages resolve through caret ranges, so an `npm update`, or a fresh install on another day, moves them under the same Melian release.

Example: pi-ai turns a conversation into a provider's request through the OpenAI client beneath it. A reinstall that moves that client from 7.19.0 to 7.20.0 leaves pi-ai at 1.1.0, so a repeat review reuses a lens run another request built. A newer `yaml` can read a `melian.yaml` differently under the same `codeVersion("checks")`, and a repeat review reuses a guardrails run the old parser decided.

The first forms keyed only what each producer's imports reach, walking manifests from each root. Every review found a layout the walk missed: a link swap, a `node_modules` made by hand inside a package, a platform build's own dependencies, an entry module in a nested package, an npm alias. Each fix taught the walk another rule of npm's or Node's. A digest of what an import reaches has to re-derive Node's resolution, and it was wrong again each round.

## The change

**The guarantee:** two installs with one digest hold the same release and the same link at every place in every `node_modules` tree Node searches beneath the install root, so every import from Melian's code reaches the same release.

`Install.read`, in `pipeline/src/installed-packages.ts`, lists every copy and every link beneath the install root, whether any import reaches it or not. Every producer keys that one digest: the lens request's `packages`, the mutant lister's `packages` beside its version and source, the check request's `packages`, and the adjudication task's `packages`. `melianInstall()`, in `code-version.ts`, reads Melian's own install once a process. `TypeScriptMutationAdapter.install()` reads the install beneath the instrumenter it resolved, from the resolved module itself, in Melian's install or the checkout's.

**The authority is the directory layout Node resolves from.** Node's resolver finds a bare import by looking in the `node_modules` of the importing file's directory, then of each ancestor. It follows a link to its real path before resolving that file's own imports. So what a module can reach is fixed by the `node_modules` trees on its ancestor chain, the trees beneath each package in them, and where each link points. The walk reads exactly those, with `readdirSync` and `lstatSync`, and follows no link:

- The install root is the outermost ancestor of the module that holds a `node_modules`, since Node searches every ancestor's.
- In a `node_modules` directory, each child is a package slot, and an `@scope` child holds slots. A name starting with a dot, such as `.bin` or `.cache`, is walked as a plain tree.
- A package records `place name@version`, read from its `package.json`, or `place without a manifest`, since Node can load one. Its subdirectories are walked for a nested `node_modules`.
- A link records `place links target`, and is never walked through. A target beneath the root is walked where it really is, with each `node_modules` on its ancestor chain up to the root, since Node resolves the target's imports from there. A linked package records its target's release but not its files, since a workspace package's source is no release; the code version covers it.
- A link that resolves nowhere records `place links nowhere`.

The lockfile is not asked. It records what npm meant to install, not what Node finds, and a hand edit, `npm link` or a second package manager changes the second without the first.

`place` is the path relative to the install root, with `/` between its parts on every platform. The digest is a SHA-256 over the sorted lines, each ended by a newline. One layout at two absolute paths gives one digest, so a host and an Actions runner that run `npm ci` on one lockfile share it. In this repository the walk reads 2,263 directories and writes 402 lines, 31 of them links, in about 90 ms, once a process.

**A bound.** The walk reads at most `maxInstallDirectories`, 50,000 directories, and past it fails the key: "Melian cannot key its install: it holds more than 50000 directories." That is 22 times this repository's install. A global install whose root is `/usr/lib` reads every global package, and one that big fails closed rather than walk without end.

Seven layouts collided under the earlier forms. Each is a named test in `installed-packages.test.ts` that the digest now tells apart:

1. two parents swap which release of a shared dependency each resolves;
2. two copies of one release swap which dependency each resolves;
3. a workspace package nests one copy and the root hoists another;
4. a nested dependency moves up to the root;
5. two links swap which release each resolves, with the real places held;
6. a `node_modules` made by hand inside a package's own directory, such as `pi/cjs/node_modules`, changes;
7. a platform build's own dependency moves, and a package's entry in a nested directory with its own `node_modules` changes.

An npm alias, `node_modules/sdk` holding `real-sdk@2.0.0`, is an eighth test. It reads as `node_modules/sdk real-sdk@2.0.0`, and moving it moves the digest. Against main's walk at 56f7fb059, the hand-made nested, platform, nested entry and dev dependency cases each kept the digest, and the alias failed the key, so every review would have failed.

## What it gives up

Any change to the install reruns every producer: a dev dependency's move, a dedupe that moves a copy with no release changed, a new `.bin` link, a package nothing of Melian's imports. A lens run costs tokens, about $5 a full round here; a check run costs minutes and no tokens; an adjudication costs no model call. In this repository, `package-lock.json` changed in 20 of the 299 first-parent commits on `main` since 2026-10-03, so runs miss about once in fifteen commits. A host and a runner share runs only if their layouts match, as `npm ci` on one lockfile gives.

What the walk does not see, and why each is left:

- **A file's contents within a release.** A hand edit inside `node_modules` keeps the line. [The request-key decision](2026-11-14-request-keys-as-built.md) already leaves out "A hand edit or `npm link` inside an install a manager recorded, and nothing else."
- **A `node_modules` beneath the root that no walked tree holds**, such as one made by hand in `scripts/` or in a workspace package's `src/`. No module of Melian's resolves from there, except a workspace module beside it, which only a hand edit makes.
- **CommonJS's global folders**, `NODE_PATH` and `~/.node_modules`. Melian is ESM, whose resolver never reads them.

## An install Melian cannot identify

A link out of the install, such as `npm link yaml` to `/work/yaml`, names a place the walk cannot read without walking the host. It records the fixed line `node_modules/yaml links outside the install`, adds the place to `outside`, and walks no further. The digest stays deterministic, and `identified` reads false. No value drawn at random enters any key, so rule 6 of [the identity guideline](../guidelines/identity.md#rules) stands as written, and this decision amends nothing there.

The flag gates reuse where a key is looked up, as `checkReusable` already does for an unread policy and an unidentified checkout install, by [the request-key decision](2026-11-14-request-keys-as-built.md). Three places carry it. Each has a test that two reviews on the same unidentified install share a key and reuse nothing:

1. **Checks.** The check request stores `packages` as `{ digest, identified }`, and `checkReusable` requires both install flags to be exactly `true`. A request stored with `packages` as a bare digest, or none, is not keyed fully. Tests in `check-request.test.ts` and `static-proof.test.ts`.
2. **Lenses.** `runLenses` takes `reusable`, false when Melian's install or the instrumenter's is unidentified. It then neither attaches to the stored task nor copies a lens run from another. Tests in `lens-reuse-review.test.ts`: the second review asks every lens again, and copies none.
3. **Adjudication.** A review and a repeated dismissal attach to the stored adjudication only on an identified install. Tests in `review.test.ts` and `dismiss.test.ts`.

`melian doctor` names each place that links out on its `packages` line, as a warning.

## Failing closed

A module whose path cannot be read, a module beneath no `node_modules`, a directory the walk cannot read, a manifest that is not JSON, and an install past the bound each fail the key with a reason. The key never holds an empty or partial list.

An adjudication task whose `packages` differs from the running install's fails, as one with another build's `code` does, and decides nothing. `packages` takes no task version. The task has no input schema, so a build reads an unknown field without complaint. Any build that does not know the field also has other adjudication code, so its `code` check fails the task before the field matters, and the next review decides again. `adjudication-key-reopen.test.ts` reopens a version 8 task main's own code left pending, from `fixtures/adjudication-key-main/pending-8.sqlite`; it fails, and the next review decides again with no model call.

## Melian's own packages

The walk lists Melian's own packages like any other. A published install reads `node_modules/@melian-agent/core @melian-agent/core@1.1.0`, and a checkout reads the workspace link and the release at `packages/core`. So the digest covers a published pipeline paired with another core. Each workspace package also names the others at their exact version, as AGENTS.md asks of every direct dependency, and `scripts/check-pinned-deps.mjs` fails any workspace dependency that is not that package's own version. **A release must bump every workspace package in lockstep**, and update each package's dependencies on the others in the same commit, or the gate fails.

## What it costs

Every stored lens run, check run and adjudication misses once on upgrade. After that, every install change misses once, as above.
