# Request keys hold Melian's whole install

Amends: [A producer's code version comes from recorded module hashes](2026-11-18-code-versions-from-recorded-hashes.md), "How it is built" and "What it gives up", whose sentences that installed packages are left out, since the lockfile pins them, this replaces

Amends: [The checks' code version comes from recorded module hashes](2026-11-20-check-code-from-recorded-hashes.md), "The change", which now holds Melian's install beside the checks' code

Amends: [A lens run offered `list_mutants` keys the instrumenter that answers it](2026-11-16-lens-request-keys-the-mutant-instrumenter.md), whose key held the instrumenter's version but not the install it runs from

Amends: [A lens run is reused by its request key, one lens at a time](2026-11-15-lens-runs-reused-per-request.md), whose key held the versions of Pi Durable and pi-ai alone

Amends: [Review attachment](2026-10-03-review-attachment.md), "a repeat call attaches, never duplicates", on an install Melian cannot identify, where a review does not resume its own interrupted lens task, so a crash there costs a full rerun of every lens

Status: the coordinator chose this design on 2026-11-20, in its session, on [issue #470](https://github.com/melian-agent/melian/issues/470), after reviews found a new collision in each earlier form: one digest over the whole install, a fixed entry and a flag for an install Melian cannot identify, and the bound. Those are the coordinator's choices, not a maintainer's ruling. The maintainer confirmed the whole-install key on 2026-11-21, in the coordinator's session, and agreed there that a review on an unidentified install does not resume its own interrupted lens task.

## Problem

A request key held the versions of Pi Durable and pi-ai, and of the instrumenter for a run offered `list_mutants`, but none of the packages beneath them. The checks' and adjudication's keys held no installed package at all. Those packages resolve through caret ranges, so an `npm update`, or a fresh install on another day, moves them under the same Melian release.

Example: pi-ai turns a conversation into a provider's request through the OpenAI client beneath it. A reinstall that moves that client from 7.19.0 to 7.20.0 leaves pi-ai at 1.1.0, so a repeat review reuses a lens run another request built. A newer `yaml` can read a `melian.yaml` differently under the same `codeVersion("checks")`, and a repeat review reuses a guardrails run the old parser decided.

The first forms keyed only what each producer's imports reach, walking manifests from each root. Every review found a layout the walk missed: a link swap, a `node_modules` made by hand inside a package, a platform build's own dependencies, an entry module in a nested package, an npm alias. Each fix taught the walk another rule of npm's or Node's. A digest of what an import reaches has to re-derive Node's resolution, and it was wrong again each round.

## The change

**The guarantee:** two installs with one digest hold the same manifest and the same link at every place in every `node_modules` tree Node searches beneath the install root, so every import from Melian's code reaches the same release.

`Install.read`, in `pipeline/src/installed-packages.ts`, lists every copy and every link beneath the install root, whether any import reaches it or not. Every producer keys that one digest: the lens request's `packages`, the mutant lister's `packages` beside its version and source, the check request's `packages`, and the adjudication task's `packages`. `melianInstall()`, in `code-version.ts`, reads Melian's own install once a process. `TypeScriptMutationAdapter.install()` reads the install beneath the instrumenter it resolved, from the resolved module itself, in Melian's install or the checkout's.

**The authority is the directory layout Node resolves from.** Node's resolver finds a bare import by looking in the `node_modules` of the importing file's directory, then of each ancestor. It follows a link to its real path before resolving that file's own imports. So what a module can reach is fixed by the `node_modules` trees on its ancestor chain, the trees beneath each package in them, and where each link points. The walk reads exactly those, with `readdirSync` and `lstatSync`, and follows no link:

- The install root is the outermost ancestor of the module that holds a `node_modules`, since Node searches every ancestor's.
- A directory named `node_modules` is a `node_modules` tree wherever it sits, in a scope, in another `node_modules` or in a package's subdirectory, since Node searches every directory of that name on the way up from a requiring file, whatever holds it. The walk takes a directory's kind from its name before its parent's, so `node_modules/@scope/node_modules` is walked as a tree of packages, each keyed by its manifest, and not as one package with no manifest.
- In a `node_modules` directory, each other child is a package slot, and an `@scope` child holds slots. A name starting with a dot, such as `.bin` or `.cache`, is walked as a plain tree.
- A package records `[place, "manifest", digest]`, a SHA-256 of its `package.json`'s bytes, or `[place, "no manifest"]`, since Node can load one. The whole manifest is keyed, not its name and version alone, because `exports`, `main` and `type` change what runs at one version. The digest is over the file's bytes, not core's `canonicalJson`, which refuses a fraction or a lone surrogate that a manifest may hold. Melian does not parse it: Node strips a byte-order mark that `JSON.parse` refuses, so a parse would fail a manifest Node loads, as the review of record found. Its subdirectories are walked for a nested `node_modules`.
- A link records `[place, "links", target]`, and is never walked through. A target inside the install, as [An install Melian cannot identify](#an-install-melian-cannot-identify) bounds it, is walked where it really is, with each `node_modules` on its ancestor chain up to the root, since Node resolves the target's imports from there. A linked package records its target's manifest but not its other files, since a workspace package's source is no release; the code version covers it.
- A link that resolves nowhere records `[place, "links nowhere"]`.

The lockfile is not asked. It records what npm meant to install, not what Node finds, and a hand edit, `npm link` or a second package manager changes the second without the first.

`place` is the path relative to the install root, with `/` between its parts on every platform. Each entry is a list of strings, and the digest is a SHA-256 over core's `canonicalJson` of the sorted list of entries. No place, target or manifest digest can stand for a kind or for another field, since each is a JSON string of its own. One layout at two absolute paths gives one digest, so a host and an Actions runner that run `npm ci` on one lockfile share it. In this repository the walk reads 2,263 directories and writes 402 entries, 31 of them links, in about 90 ms, once a process.

**A bound.** The walk reads at most `maxInstallDirectories`, 50,000 directories, and past it fails the key: "Melian cannot key its install: it holds more than 50000 directories." That is 22 times this repository's install. A global install whose root is `/usr/lib` reads every global package, and one that big fails closed rather than walk without end.

Seven layouts collided under the earlier forms. Each is a named test in `installed-packages.test.ts` that the digest now tells apart:

1. two parents swap which release of a shared dependency each resolves;
2. two copies of one release swap which dependency each resolves;
3. a workspace package nests one copy and the root hoists another;
4. a nested dependency moves up to the root;
5. two links swap which release each resolves, with the real places held;
6. a `node_modules` made by hand inside a package's own directory, such as `pi/cjs/node_modules`, changes;
7. a platform build's own dependency moves, and a package's entry in a nested directory with its own `node_modules` changes.

Codex's review of the first whole-install form found that its text lines could be forged. A link to a directory named `nowhere` wrote the line of a link that names no directory, a space in a place shifted where a link's target began, and an `@` in a manifest's name moved where its version began. Each is a named test that failed on the text lines and passes on the entries.

Codex's next review found that two installs whose packages differ under one name and version shared a digest. On 2026-11-20 the coordinator chose to key each whole manifest. A changed `exports`, `main` or `type` at one name and version is now a named test that failed on the name and version alone and passes on the manifest's digest.

An npm alias, `node_modules/sdk` holding `real-sdk@2.0.0`, is an eighth test. It reads as `["node_modules/sdk", "manifest", digest]` of a manifest that names `real-sdk`, and moving it moves the digest. Against main's walk at 56f7fb059, the hand-made nested, platform, nested entry and dev dependency cases each kept the digest, and the alias failed the key, so every review would have failed.

## What it gives up

Any change to the install reruns every producer: a dev dependency's move, a dedupe that moves a copy with no release changed, a new `.bin` link, a package nothing of Melian's imports. A lens run costs tokens, about $5 a full round here; a check run costs minutes and no tokens; an adjudication costs no model call. In this repository, `package-lock.json` changed in 20 of the 299 first-parent commits on `main` since 2026-10-03, so runs miss about once in fifteen commits. A host and a runner share runs only if their layouts match, as `npm ci` on one lockfile gives.

What the walk does not see, and why each is left:

- **Any file beneath a package but its manifest.** Each of these keeps the digest, and each is a named test in `installed-packages.test.ts`:
  - a patched file, as patch-package makes;
  - a postinstall script's output;
  - a native binary;
  - another tarball a registry serves under one version, with the same manifest;
  - any file of a package with no manifest.

  A hand edit inside `node_modules` keeps it too. [The request-key decision](2026-11-14-request-keys-as-built.md) already leaves out "A hand edit or `npm link` inside an install a manager recorded, and nothing else". Keying every file would hash the whole of `node_modules`, tens of thousands of files here, and that is another mechanism at another cost, which the coordinator chose not to build on 2026-11-20.

  npm's hidden lockfile, `node_modules/.package-lock.json`, would catch the registry case where npm's install took a different tarball. npm writes it on every install, with each place's `version`, `resolved` URL and `integrity`, a SHA-512 of the tarball npm verified. Here it is 178 KB with 379 entries, 363 of them with an integrity, and it parses in about 2 ms, so reading it would cost little. It catches less than it seems. `npm ci` already refuses a tarball whose integrity differs from the committed lockfile's, so two hosts that run `npm ci` on one lockfile cannot take different tarballs. The integrity is npm's record of the tarball, not of the files on disk, so it misses the patched file, the postinstall output and a hand edit. pnpm, Yarn and Bun write no such file, so an install by another manager would need its own rule. It is the lockfile's answer, not Node's, which this decision set aside above. Melian does not read it.
- **A `node_modules` beneath the root that no walked tree holds**, such as one made by hand in `scripts/` or in a workspace package's `src/`. No module of Melian's resolves from there, except a workspace module beside it, which only a hand edit makes.
- **CommonJS's global folders**, `NODE_PATH` and `~/.node_modules`. Melian is ESM, whose resolver never reads them.
- **The install beneath triage, verification and the walkthrough.** Their keys hold no `packages` yet, so after an install change lenses rerun and triage may attach to a decision the older install made, which can keep a lens at a lower level. On 2026-11-20 the coordinator put them with the second half of [issue #437](https://github.com/melian-agent/melian/issues/437), stacked on this change, so each task changes version once and takes the module digest and `packages` together.

## An install Melian cannot identify

A link out of the install, such as `npm link yaml` to `/work/yaml`, names a place the walk cannot read without walking the host. It records the fixed entry `["node_modules/yaml", "links outside"]`, adds the place to `outside`, and walks no further. The digest stays deterministic, and `identified` reads false. No value drawn at random enters any key, so rule 6 of [the identity guideline](../guidelines/identity.md#rules) stands as written, and this decision amends nothing there.

A link out of the project that holds it counts as a link out of the install. Melian's round at `31c0dd74e` found that a stray `node_modules` in a home directory raised the install root to that directory, so `npm link yaml` from a checkout to `~/work/yaml` read as a link inside, keyed only its manifest, and left the install identified. A link's target now counts as inside only when it lies beneath the nearest directory of the module's chain that holds the link. That directory is never one under a `node_modules`, since npm and pnpm both put a package there: Melian's round at `68305a957` found that a module read from inside a pnpm store's entry made the entry its project, so the entry's links to its sibling packages read as outside and every pnpm install was unidentified. Nearest to the module would not do: `packages/pipeline` holds a `node_modules` of its own, so every workspace link in the root's `node_modules` would read as outside. In a checkout, the repository root holds those links, so they stay inside, and so do a pnpm store's links between its packages. Each is a named test. Two residuals stay: a link inside the project to a directory that is no workspace package, such as npm's `file:./vendor/x`, keys only its manifest, and a link in the stray `node_modules` itself is judged against the directory that holds it.

A layout other than npm's leaves the install unidentified the same way, with each place in `unrecognised`. Codex's eighth review found that Yarn's Plug'n'Play keeps packages in zip archives, which Yarn's patched fs opens as directories, so the walk could key one archive's tree and call the install identified. Melian does not read Yarn's map. On 2026-11-20 the coordinator chose to detect the layout instead, and to add one general guard, so the next layout fails safe without a review finding it. Each of these is unrecognised, and a named test in `installed-packages.test.ts`:

- a `.pnp.cjs` or `.pnp.loader.mjs` in the module's directory or any directory above it, the install root's parents included;
- a module whose path runs through a component ending `.zip`;
- a walked directory whose name ends `.zip`;
- a directory the walk reaches as two kinds of place, such as a linked scope over a directory it keys as a package, which Melian's round found at `559cfd32f`: the scope's packages entered no entry, so pi-ai's version moved and the digest held;
- the general guard: a module beneath a `node_modules` that no package the walk keyed holds, such as one in `node_modules/.store/pi`.

A module in an installed package, a pnpm store's package, or a workspace package npm links is recognised, each a named test. A further layout a reviewer finds is handled as [the walk's boundary](#the-walks-boundary) says.

The flag gates reuse where a key is looked up, as `checkReusable` already does for an unread policy and an unidentified checkout install, by [the request-key decision](2026-11-14-request-keys-as-built.md). Three places carry it. Each has a test that two reviews on the same unidentified install share a key and reuse nothing:

1. **Checks.** The check request stores `packages` as `{ digest, identified }`, and `checkReusable` requires both install flags to be exactly `true`. A request stored with `packages` as a bare digest, or none, is not keyed fully. Tests in `check-request.test.ts` and `static-proof.test.ts`.
2. **Lenses.** `runLenses` takes `reusable`, false when Melian's install or the instrumenter's is unidentified. It then neither attaches to the stored task nor copies a lens run from another. That holds for the review's own task too, so a crash on an unidentified install costs a full rerun of every lens, as the maintainer agreed on 2026-11-21. The lens request holds `identified` beside `packages`, so a review on an identified install never attaches to a run made on an unidentified one with the same digest, which the review of record found the gate alone allowed. Tests in `lens-reuse-review.test.ts`: the second review asks every lens again, and copies none, whichever of the two installs is unidentified.
3. **Adjudication.** A review and a repeated dismissal attach to the stored adjudication only on an identified install, and the task input holds `identified` beside `packages` for the same reason. Tests in `review.test.ts` and `dismiss.test.ts`, with an unidentified install first and with it second.

`melian doctor` names each place that links out, and each place not laid out as npm lays out an install, on its `packages` line, as a warning.

## The walk's boundary

Melian's round at `31c0dd74e` found two more shapes the walk mishandled, after the review of record had found a third: a directory reached as two kinds of place, a root raised by a stray `node_modules`, and a manifest that is no regular file. On 2026-11-20 the coordinator asked whether the walk should go, and the static check's record key take its place. It answered that the walk stays, and set its boundary in three parts.

**What the walk promises.** A shape made outside npm reads as unidentified wherever the walk can see it: a link out of the project that holds it, a layout other than npm's, a directory or manifest it cannot read. An unidentified install reuses nothing, so a shape the walk sees can cost model spend but never stands one install for another.

**Two gaps left open by choice.** Neither changes a place, a link or a manifest, so neither moves the digest:

- a linked package's files edited in place, such as `src/index.js` in the directory `npm link` points `node_modules/yaml` at;
- a file under `node_modules` changed by hand after install, such as a line added to `node_modules/ms/index.js`.

Closing either means hashing every file, which [What it gives up](#what-it-gives-up) sets aside.

**Why the static check's record key was not used.** `installDigests`, which keys a check run, hashes the lockfile and npm's record, `node_modules/.package-lock.json`, and npm itself trusts that record only after Arborist's `assertNoNewer` walks every package directory. In a scratch install of `debug@4.3.4` and `ms@2.0.0`, the record hashed `d19589024f16` before and after `ms` was copied by hand into `debug/node_modules`, and after `node_modules/ms` was swapped by hand for a link out of the install. The walk tells both apart. A global install, `npm install -g`, writes no record at all, so a record key would leave every such install of Melian unidentified for good.

**Two kinds of shape.** Reviews of this pull request found thirteen shapes the walk mishandled, and they are of two kinds, which the coordinator set on 2026-11-21 are not handled alike. A shape where the walk reads an install as identified when its code could have changed lets a stale answer be reused: that is a defect in the key, it blocks, and it goes to the coordinator before any fix. A shape where the walk reads an ordinary install as unidentified loses reuse but never reuses wrongly: it becomes a follow-up issue with the layout and a reproduction, which the maintainer reads as an acknowledge, and it holds no pull request.

## Failing closed

A module whose path cannot be read, and a module beneath no `node_modules`, each fail the key with a reason, and a review that keys Melian's install, or the instrumenter's for `list_mutants`, fails with it. The key never holds an empty or partial list. Those two stay failures: neither is a layout a review can work around, and a review that ran under them would key nothing. On 2026-11-21 the coordinator corrected the bound for the instrumenter's install, after Melian's round at `5cc5b261f` found that a customer monorepo of more than 50,000 directories, an ordinary layout the base reviewed, aborted every review that offered `list_mutants`: the bound was sized for Melian's own install. Past it, the walk of the instrumenter's install stops, reading no further directory and following no further link, and leaves the install unidentified with its root, `.`, in `unrecognised`, so the review runs and reuses nothing. On 2026-11-22 the coordinator chose the same for Melian's own install, after Melian's round at `a20f36c68` found that a global install, where Melian shares one `node_modules` with other tools, aborted every review once that root passed the bound.

A directory the walk cannot read, such as a root-owned `node_modules/.cache`, or a scope linked to a file, and a manifest it cannot read, record no list of what they hold. So does a manifest that is no regular file, such as a FIFO, which Melian's round at `31c0dd74e` found blocked the walk for good: the walk reads a manifest only after `lstat` finds a regular file. Each leaves the install unidentified with its place in `unrecognised`, and an unreadable manifest records `[place, "unreadable manifest"]`. The review of record found that a failure there aborted any review that offered `list_mutants`, where the base ran; a review that reuses nothing is better than one that aborts. The coordinator chose this on 2026-11-20.

An adjudication task whose `packages` differs from the running install's fails, as one with another build's `code` does, and decides nothing. `packages` and `identified` take no task version. The task has no input schema, so a build reads an unknown field without complaint. Any build that does not know the field also has other adjudication code, so its `code` check fails the task before the field matters, and the next review decides again. `adjudication-key-reopen.test.ts` reopens a version 8 task main's own code left pending, from `fixtures/adjudication-key-main/pending-8.sqlite`; it fails, and the next review decides again with no model call.

## Melian's own packages

The walk lists Melian's own packages like any other. A published install reads `["node_modules/@melian-agent/core", "manifest", digest]` of the manifest that names `@melian-agent/core` at 1.1.0, and a checkout reads the workspace link and the manifest at `packages/core`. So the digest covers a published pipeline paired with another core. Each workspace package also names the others at their exact version, as AGENTS.md asks of every direct dependency, and `scripts/check-pinned-deps.mjs` fails any workspace dependency that is not that package's own version. **A release must bump every workspace package in lockstep**, and update each package's dependencies on the others in the same commit, or the gate fails.

## What it costs

Every stored lens run, check run and adjudication misses once on upgrade. After that, every install change misses once, as above.
