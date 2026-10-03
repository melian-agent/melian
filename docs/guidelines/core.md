# Core guidelines

The core package holds the review domain: changesets, configuration, standards, and later findings, lenses, and checks. Everything in it runs without a harness, so a unit test needs nothing but Node, git, and a temporary directory.

## Harness-free

Core imports nothing from Pi Durable, Chord, or another Melian package. The design permits pi-ai's types; nothing needs them yet. `packages/core/test/harness-free.test.ts` fails the gate if core imports Pi or a Melian package, and so does the pipeline's `test/harness-boundary.test.ts` for Pi. Widen both in the change that first needs pi-ai's types, and import types only.

Problem: a domain rule written against the harness can only be tested through the harness. Example: checking that a `P2` finding needs acknowledgement would mean opening a durable session. Solution: core takes plain values and returns plain values; the pipeline feeds it and stores what it returns.

## Git by shelling out

Core reads repositories by running the `git` executable through `src/git.ts`. It never uses a JavaScript reimplementation of git, which drifts from git on renames, merge bases, and configuration.

- Never let the caller's environment pick the repository. A git hook runs with `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and their kin set for its own repository, and git honours them over the working directory. `src/git.ts` removes every variable `git rev-parse --local-env-vars` lists before it spawns git.
- Never let the checked-out head choose diff attributes. git reads `.gitattributes` from the working tree, which often holds the head under review, so a head that adds `*.ts -diff` turns its own changes into binary files with no hunks. Every diff passes `--attr-source=<base>`. That flag needs git 2.40, so `resolveRange` checks the version once per process and throws `gitTooOld` rather than review with the head's attributes.
- Run git with an argument array, never a shell string. Refuse a ref beginning with `-` before it reaches the argument list, as `checkRange` does.
- Pass diff flags explicitly. A user's `diff.algorithm`, `diff.renames`, `diff.renameLimit`, `diff.interHunkContext`, `diff.submodule`, `diff.ignoreSubmodules`, `diff.orderFile`, or `color.diff` must not change what Melian sees. Nor may a repository's own `.gitmodules`: a head commit that sets `ignore = all` for a submodule would otherwise hide its own pointer change, so every diff and status passes `--ignore-submodules=none`. `src/changeset.ts` pins them, and a test in `test/changeset.test.ts` resolves a range under each setting and expects the same changeset. Add a setting there when you pin a flag.
- Ask git for machine formats: `-z` for paths, `--raw` for status and modes, `--numstat` for binary detection. Parse the unified diff only for hunks, and only the `@@ -a,b +c,d @@` headers and the lines under them.
- Read modes from `--raw`, never from the patch. A file made executable, a file that became a symlink, and a moved submodule pointer all change what a reviewer must look at, and `--name-status` reports the first as a bare `M`. `ChangedFile` carries `oldMode` and `newMode` and the `FileKind` each names.
- Git emits the raw, numstat, and patch views of one diff in the same file order. The parser joins them by position and fails if the counts disagree. One exception reads like a bug: a type change, such as a file becoming a symlink, is one raw entry but two patch sections, a deletion and an addition.
- Report failures as `ChangesetError` codes, never as thrown strings. Give a specific code only when git's output confirms it: "not a git repository" on stderr, or a silent exit from `rev-parse --verify --quiet` or `merge-base`. Anything else is `gitFailed` carrying git's stderr, because a refusal over dubious ownership that reads as "not a repository" sends the user looking in the wrong place.

Two-dot and three-dot ranges differ. `main..feature` diffs `main` against `feature` directly, so anything `main` gained after `feature` branched shows up reversed. `main...feature` diffs from their merge base, which is what a pull request shows. A bare ref means three dots against `HEAD`, the default for the CLI.

## Reading policy and standards from a source

`loadConfig(repoRoot, source, path)` and `loadStandards(repoRoot, source, path)` read every file through `src/source.ts`, never `node:fs` directly. The host passes `{ kind: "revision", commit }` or `{ kind: "worktree" }`; [design.md](../design.md#policy-and-standards-come-from-a-revision-the-host-chooses) says which and why. Core does not choose.

Problem: a loader that reads the checkout reviews a pull request under the pull request's own `melian.yaml`. Example: a head commit sets `resolution: { P0: silent }` and its review blocks nothing. Solution: the host passes the base commit, and the revision source reads blobs with `git ls-tree` and `git cat-file`, so neither the checked-out branch nor uncommitted edits reach the loader.

Both sources implement one interface, `readText`, `list`, and `exists`, over repository-relative paths, and share these rules:

- Never follow a symlink. `readText` throws `symlink` for one; a path beneath a symlinked directory does not exist. The worktree source checks each component with `lstat` and opens with `O_NOFOLLOW`; the revision source reads the mode from `ls-tree`. `loadConfig` turns a symlinked `melian.yaml` into a `ConfigError`. `loadStandards` skips a symlinked standards file, so a `CLAUDE.md` linked to `AGENTS.md` costs nothing; the target is read under its own name if it is a standards file.
- Only absence is silent. A missing file is `undefined`; any other failure is `unreadable`, carried into `ConfigError` or `StandardsError` with the path.
- Bounds are errors, never truncation: `maxConfigBytes` (64 KiB) per `melian.yaml`, and `standardsLimits` (256 KiB per file, 1 MiB for one path's standards in all).
- Paths stay repository-relative. `ConfigError.file`, `LoadedConfig.sources`, and `StandardsSection.path` carry them; messages about a revision name the file as git does, `<commit>:<path>`.
- `@` imports follow Claude Code: an `@path` token anywhere in the text, after whitespace or at the start of a line, outside code spans and code blocks fenced with ``` or ~~~. They resolve lexically against the importing file and are dropped if they climb out of the repository or name anything but a file, since `@docs` in prose is not an import. Nothing calls `realpath`.

`.melian/` may sit in any directory, as `melian.yaml` may. For each directory from the path's up to the root, `loadStandards` reads `AGENTS.md`, `CLAUDE.md`, then `.melian/standards/*.md` in name order, so a service's own standards come before the root's. Lenses will resolve the same way; knowledge is read from the root `.melian/` only.

## Layering precedence

Every `melian.yaml` from a path's directory up to the repository root applies, over the built-in defaults. The nearest file wins per key. Objects merge key by key; arrays and scalars replace whole. A lens's `paths` are relative to the file that declares them, a leading `/` included, and the loader rewrites them to be repository-relative before merging, keeping a leading `!` for exclusions. It normalises root and nested patterns alike, so `./src/**` becomes `src/**`, and a pattern whose `..` climbs out of the repository is an `invalidValue` error naming the file and `lenses.<name>.paths`.

Example: the root and one service both configure Melian.

```yaml
# melian.yaml
resolution:
  P2: block
lenses:
  security:
    tier: medium
    paths: [src/**]
models:
  heavy:
    model: anthropic/opus
    fallbacks: [openai/gpt]

# services/payments/melian.yaml
resolution:
  P3: block
lenses:
  security:
    tier: heavy
    paths: [api/**]
models:
  heavy:
    model: anthropic/sonnet
```

For `services/payments/api/charge.ts`, the effective configuration is:

```yaml
resolution: { P0: block, P1: block, P2: block, P3: block, nit: silent }   # P2 from the root, P3 from the service
lenses:
  security: { tier: heavy, paths: [services/payments/api/**] }           # the service's array replaces the root's
models:
  heavy: { model: anthropic/sonnet, fallbacks: [openai/gpt] }             # objects merge, so the root's fallbacks stay
```

The last line is the trap: a nearer file that changes a model keeps the farther file's fallbacks. Restate `fallbacks` when they should change too. `test/config.test.ts` pins this example.

The keys a `melian.yaml` accepts, all optional:

| Key | Shape | Default |
|---|---|---|
| `tiers` | tier name to a list of check names or other tiers | `fast`, `standard`, `full` as in the design |
| `stages` | stage name to tier name | `pre-commit: fast`, `pre-push: standard`, `pull-request: full`, `comment: standard` |
| `resolution` | `P0` to `P3` and `nit`, each `block`, `acknowledge`, `advisory`, or `silent` | `P0` and `P1` block, `P2` acknowledge, `P3` advisory, `nit` silent |
| `lenses` | lens name to `enabled`, `tier` (`light`, `medium`, `heavy`), and `paths` | none |
| `models` | `light`, `medium`, `heavy`, or `decision` to `model` and `fallbacks` | none |
| `knowledge` | `writeBack`, a boolean | `false` |
| `decisions` | `provider`, and `thresholds` from question name to a `drop` and `accept` band between 0 and 1 | no provider, no thresholds |

Lenses are a map keyed by name rather than `enable` and `disable` lists, so that layering works per lens: a service can disable one lens without restating the root's list. A band layers like any object, so a nearer file may restate only `drop` or only `accept`. A merged band missing either end, or whose `drop` exceeds its `accept`, is an error naming the nearest file that set it.

Unknown keys are errors that name the key and the file, because a misspelt key otherwise falls back to a default without a word.

A `__proto__` key anywhere is a `reservedKey` error. Problem: `lenses: { __proto__: { tier: heavy } }` merged into a plain object replaces its prototype, so every lens no file configures appears to have `tier: heavy`. Solution: the loader refuses the key, and builds merged objects with no prototype, so a lens named `constructor` or `toString` is looked up like any other.

## Tests

- Run the package's tests with `npm test --workspace @melian-agent/core`, or one file with `npx vitest --run packages/core/test/changeset.test.ts` from the repository root.
- Build real repositories in a temporary directory in `beforeEach` with `test/fixtures/repo.ts`, and delete them in `afterEach`. Never mock git.
- Isolate git from the developer's configuration. `isolatedGitEnv` points `GIT_CONFIG_GLOBAL` at `/dev/null` and sets an author; without it, a developer who signs commits sees every fixture commit fail. Stub the same variables into `process.env` while code under test runs git.
- Take temporary directories through `temporaryDirectory()`, which resolves symlinks. On macOS the system temporary directory is a symlink, and git reports the resolved path, so a comparison with the unresolved one fails.
- Assert exact hunk ranges against a diff small enough to check by eye.
- Run every loader test against both sources with `describe.each(sourceKinds)`. `sourceFor(root, kind)` commits the working tree for a revision, so one body checks that the two agree. Test what only a revision guarantees, such as ignoring the checked-out branch, in a block of its own.
- Await a rejection with `rejection(promise, ErrorClass)`, which fails unless the promise rejects with that class and returns the error typed.
