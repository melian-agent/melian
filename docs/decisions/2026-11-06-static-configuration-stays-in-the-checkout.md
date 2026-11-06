# A static tool's configuration stays in the checkout

Status: asked for by the maintainer in [issue #281](https://github.com/melian-agent/melian/issues/281), 2026-11-06.

Amends: [Static checks run unconfined; only agents are sandboxed](2026-10-14-static-checks-run-unconfined.md), the second bullet of "What this gives up", which accepted that a head's `biome.json` extending an absolute path has Biome quote that file.

## Problem

Biome and tsc read whatever file a head's configuration names, and Melian stored what they printed. A stored error reaches the verdict, `melian findings` and every published review.

Example: the Opus review of record on [pull request #275](https://github.com/melian-agent/melian/pull/275) committed `{"extends": ["<absolute path>/environ"]}`. Biome could not parse the file and quoted it, a fake token included, and `static.ts` kept 4,096 characters of that stderr as the check's error. Biome labels each quoted frame with the extending file's name, `biome.json:1:1`, not the file it came from. tsc follows an `extends` too, even from a `tsconfig.json` it cannot parse, and its `Unknown compiler option` message quotes the outside file's keys. [Pull request #112](https://github.com/melian-agent/melian/pull/112) met the same class in its fallback.

## Decision

1. Before Biome or tsc runs, Melian follows the revision's configuration through every entry that names another file it reads: `extends` and `plugins` for Biome, from every `biome.json`, `biome.jsonc`, `.biome.json` and `.biome.jsonc` the revision tracks; `extends` and `references` for tsc, from `static.tsc.project`. Each file is resolved through links. A Grit plugin is located, never parsed.
2. A path entry must stay inside the worktree, or inside the checkout's install. A package entry must resolve to a package the install provides, which the maintainer made from the lockfile; a package the revision itself supplies, or one with a `..` segment, is refused. The classification follows each tool: Biome reads an entry ending in `.json` or `.jsonc` as a path, tsc reads one starting with `.` or `/` as a path, and any other entry is a package.
3. A configuration file Melian cannot parse as a JSON object is refused, since Melian cannot tell what the tool would follow through it.
4. A refusal fails the check with `CheckError` code `outsideCheckout`. The error names the configuration file and the entry, and the tool never runs, so nothing reads the named file. The review is not reviewed, as for any failed check.
5. Biome's stderr is not stored. Because Biome labels quoted text with the extending file's name, no filter can tell an outside file's text from the revision's. The error keeps the exit code and says to run `biome lint` at the commit. tsc keeps its output on a crash: with `--pretty false` it prints no source frames, and each diagnostic names its own file, so `parseTscDiagnostics` drops one from outside the worktree.

## What this gives up

- A configuration that extends a package of the revision's own workspace, or a file Melian cannot parse, fails the check. Its maintainer can extend the file by path instead.
- A broken `biome.json` no longer shows Biome's message in the review. Running Biome locally shows it.
- The rule covers configuration, not source. tsc options such as `paths`, `typeRoots` and `baseUrl`, and a source file that imports a path outside the checkout, can still make tsc read such a file; a diagnostic on that file is dropped, but one on a revision file can quote a type from it. Biome's `vcs.root` can point its ignore file outside. These need their own probe and ruling.
