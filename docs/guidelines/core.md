# Core guidelines

The core package holds the review domain: changesets, configuration, standards, and later findings, lenses, and checks. Everything in it runs without a harness, so a unit test needs nothing but Node, git, and a temporary directory.

## Harness-free

Core imports nothing from Pi Durable, Chord, or another Melian package. The design permits pi-ai's types; nothing needs them yet. `packages/core/test/harness-free.test.ts` fails the gate if core imports Pi or a Melian package, and so does the pipeline's `test/harness-boundary.test.ts` for Pi. Widen both in the change that first needs pi-ai's types, and import types only.

Problem: a domain rule written against the harness can only be tested through the harness. Example: checking that a `P2` finding needs acknowledgement would mean opening a durable session. Solution: core takes plain values and returns plain values; the pipeline feeds it and stores what it returns.

## Git by shelling out

Core reads repositories by running the `git` executable through `src/git.ts`. It never uses a JavaScript reimplementation of git, which drifts from git on renames, merge bases, and configuration.

- Run git with an argument array, never a shell string. Refuse a ref beginning with `-` before it reaches the argument list, as `checkRange` does.
- Pass diff flags explicitly. A user's `diff.algorithm`, `diff.renames`, `diff.renameLimit`, `diff.interHunkContext`, `diff.submodule`, `diff.orderFile`, or `color.diff` must not change what Melian sees. `src/changeset.ts` pins them, and a test in `test/changeset.test.ts` resolves a range under each setting and expects the same changeset. Add a setting there when you pin a flag.
- Ask git for machine formats: `-z` for paths, `--numstat` and `--name-status` for file lists. Parse the unified diff only for hunks, and only the `@@ -a,b +c,d @@` headers and the lines under them.
- Git emits the name-status, numstat, and patch views of one diff in the same file order. The parser joins them by position and fails if the counts disagree. One exception reads like a bug: a type change, such as a file becoming a symlink, is one name-status entry but two patch sections, a deletion and an addition.
- Report failures as `ChangesetError` codes, never as thrown strings.

Two-dot and three-dot ranges differ. `main..feature` diffs `main` against `feature` directly, so anything `main` gained after `feature` branched shows up reversed. `main...feature` diffs from their merge base, which is what a pull request shows. A bare ref means three dots against `HEAD`, the default for the CLI.

## Layering precedence

Every `melian.yaml` from a path's directory up to the repository root applies, over the built-in defaults. The nearest file wins per key. Objects merge key by key; arrays and scalars replace whole. A lens's `paths` are relative to the file that declares them, a leading `/` included, and the loader rewrites them to be repository-relative before merging, keeping a leading `!` for exclusions.

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

Lenses are a map keyed by name rather than `enable` and `disable` lists, so that layering works per lens: a service can disable one lens without restating the root's list. A band whose merged `drop` exceeds its `accept` is an error naming the nearest file that set it.

Unknown keys are errors that name the key and the file, because a misspelt key otherwise falls back to a default without a word.

## Tests

- Run the package's tests with `npm test --workspace @melian-agent/core`, or one file with `npx vitest --run packages/core/test/changeset.test.ts` from the repository root.
- Build real repositories in a temporary directory in `beforeEach` with `test/fixtures/repo.ts`, and delete them in `afterEach`. Never mock git.
- Isolate git from the developer's configuration. `isolatedGitEnv` points `GIT_CONFIG_GLOBAL` at `/dev/null` and sets an author; without it, a developer who signs commits sees every fixture commit fail. Stub the same variables into `process.env` while code under test runs git.
- Take temporary directories through `temporaryDirectory()`, which resolves symlinks. On macOS the system temporary directory is a symlink, and git reports the resolved path, so a comparison with the unresolved one fails.
- Assert exact hunk ranges against a diff small enough to check by eye.
