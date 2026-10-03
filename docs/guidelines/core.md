# Core guidelines

The core package holds the review domain: changesets, configuration, standards, and later findings, lenses, and checks. Everything in it runs without a harness, so a unit test needs nothing but Node, git, and a temporary directory.

## Harness-free

Core imports nothing from Pi Durable, Chord, or another Melian package. The design permits pi-ai's types; nothing needs them yet. `packages/core/test/harness-free.test.ts` fails the gate if core imports Pi or a Melian package, and so does the pipeline's `test/harness-boundary.test.ts` for Pi. Widen both in the change that first needs pi-ai's types, and import types only.

Problem: a domain rule written against the harness can only be tested through the harness. Example: checking that a `P2` finding needs acknowledgement would mean opening a durable session. Solution: core takes plain values and returns plain values; the pipeline feeds it and stores what it returns.

## Git by shelling out

Core reads repositories by running the `git` executable through `src/git.ts`. It never uses a JavaScript reimplementation of git, which drifts from git on renames, merge bases, and configuration.

- Run git with an argument array, never a shell string. Refuse a ref beginning with `-` before it reaches the argument list, as `checkRange` does.
- Pass diff flags explicitly. A user's `diff.algorithm`, `diff.renames`, `diff.renameLimit`, `diff.interHunkContext`, `diff.submodule`, `diff.ignoreSubmodules`, `diff.orderFile`, or `color.diff` must not change what Melian sees. Nor may a repository's own `.gitmodules`: a head commit that sets `ignore = all` for a submodule would otherwise hide its own pointer change, so every diff and status passes `--ignore-submodules=none`. `src/changeset.ts` pins them, and a test in `test/changeset.test.ts` resolves a range under each setting and expects the same changeset. Add a setting there when you pin a flag.
- Ask git for machine formats: `-z` for paths, `--raw` for status and modes, `--numstat` for binary detection. Parse the unified diff only for hunks, and only the `@@ -a,b +c,d @@` headers and the lines under them.
- Read modes from `--raw`, never from the patch. A file made executable, a file that became a symlink, and a moved submodule pointer all change what a reviewer must look at, and `--name-status` reports the first as a bare `M`. `ChangedFile` carries `oldMode` and `newMode` and the `FileKind` each names.
- Git emits the raw, numstat, and patch views of one diff in the same file order. The parser joins them by position and fails if the counts disagree. One exception reads like a bug: a type change, such as a file becoming a symlink, is one raw entry but two patch sections, a deletion and an addition.
- Report failures as `ChangesetError` codes, never as thrown strings.

Two-dot and three-dot ranges differ. `main..feature` diffs `main` against `feature` directly, so anything `main` gained after `feature` branched shows up reversed. `main...feature` diffs from their merge base, which is what a pull request shows. A bare ref means three dots against `HEAD`, the default for the CLI.

## Reading policy and standards from a source

`loadConfig(repoRoot, source, path)` and `loadStandards(repoRoot, source, path)` read every file through `src/source.ts`, never `node:fs` directly. The host passes `{ kind: "revision", commit }` or `{ kind: "worktree" }`; [design.md](../design.md#policy-and-standards-come-from-a-revision-the-host-chooses) says which and why. Core does not choose.

Problem: a loader that reads the checkout reviews a pull request under the pull request's own `melian.yaml`. Example: a head commit sets `resolution: { P0: silent }` and its review blocks nothing. Solution: the host passes the base commit, and the revision source reads blobs with `git ls-tree` and `git cat-file`, so neither the checked-out branch nor uncommitted edits reach the loader.

Both sources implement one interface, `readText`, `list`, and `exists`, over repository-relative paths, and share these rules:

- Never follow a symlink. `readText` throws `symlink` for one; a path beneath a symlinked directory does not exist. The worktree source checks each component with `lstat` and opens with `O_NOFOLLOW`; the revision source reads the mode from `ls-tree`. `loadConfig` turns a symlinked `melian.yaml` into a `ConfigError`. `loadStandards` skips a symlinked standards file, so a `CLAUDE.md` linked to `AGENTS.md` costs nothing; the target is read under its own name if it is a standards file.
- Only absence is silent. A missing file is `undefined`; any other failure is `unreadable`, carried into `ConfigError` or `StandardsError` with the path.
- Bounds are errors, never truncation: `maxConfigBytes` (64 KiB) per `melian.yaml`, and `standardsLimits` (256 KiB per file, 1 MiB for one path's standards in all).
- Paths stay repository-relative. `ConfigError.file`, `LoadedConfig.sources`, and `StandardsSection.path` carry them; messages about a revision name the file as git does, `<commit>:<path>`.
- `@` imports resolve lexically against the importing file and are dropped if they climb out of the repository. Nothing calls `realpath`.

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

Lenses are a map keyed by name rather than `enable` and `disable` lists, so that layering works per lens: a service can disable one lens without restating the root's list. A band layers like any object, so a nearer file may restate only `drop` or only `accept`. A merged band missing either end, or whose `drop` exceeds its `accept`, is an error naming the nearest file that set it.

Unknown keys are errors that name the key and the file, because a misspelt key otherwise falls back to a default without a word.

A `__proto__` key anywhere is a `reservedKey` error. Problem: `lenses: { __proto__: { tier: heavy } }` merged into a plain object replaces its prototype, so every lens no file configures appears to have `tier: heavy`. Solution: the loader refuses the key, and builds merged objects with no prototype, so a lens named `constructor` or `toString` is looked up like any other.

## Lenses

A lens is a directory holding `LENS.md`: YAML front matter between `---` lines, then the body, which becomes the lens conversation's instructions. `lensFrontMatterSchema` is the contract; an unknown field is a `LensError` naming the file and the field.

| Field | Meaning | Default |
|---|---|---|
| `name` | Must match the directory name | required |
| `description` | One line | required, or inherited through `extends` |
| `tier` | `light`, `medium`, or `heavy` | required, or inherited |
| `tools` | Read-only tools from `lensToolNames`: `read_file`, `search`, `list_files` | all three |
| `severities` | The severities the lens may report | all five |
| `rules` | `id` and one-line `description` for each rule the lens reports under | required, or inherited |
| `paths` | Globs relative to the directory holding the lens's `.melian/` or `.agents/`; `!` excludes | `**` |
| `budget` | `findings`, a count; `tokens`, a number or `200k`, recorded but not enforced | `findings: 10` |
| `extends` | A lens to override, as layered so far | none |
| `standards` | Append the repository's standards to the instructions | `true` |

`loadLenses(repoRoot, source, paths)` layers built-ins, from `packages/core/lenses/`, under every `.agents/lenses/` and then `.melian/lenses/` from the root down to each path, and returns the union over `paths`. The nearest definition of a name wins. A definition with `extends` overrides the fields it sets on the named lens and appends its body; one without replaces any farther lens of that name. Repository lenses are read through `src/source.ts`, like configuration, so a symlinked lens directory or `LENS.md` is refused and a `LENS.md` over 64 KiB is an error.

A lens defined in a folder applies only beneath it. Problem: `services/pay/.melian/lenses/security/` extends the root's `security` and inherits its `paths: ["**"]`, which would make the payments variant review the whole repository. Solution: every lens carries a `scope`, the directory that defined it, and `selectLenses` never selects a file outside it. Two variants of one name can then run on one changeset, each over its own folder; `version`, a hash of everything that shapes the lens, tells their findings apart.

`selectLenses(lenses, config, paths)` applies `melian.yaml`'s `lenses` settings: `enabled: false` drops a lens, `tier` retiers it, and `paths` replaces its globs. `**` matches dotfiles, unlike Node's `path.matchesGlob`, so a lens over `**` sees `.github/workflows/`.

## Reading the head revision for lenses

`readRevisionFile`, `listRevisionFiles`, and `searchRevision` in `src/revision.ts` back the lens tools. They read a commit through `git ls-tree`, `git cat-file`, and `git grep`, never the working tree, so an uncommitted edit or untracked file is invisible to a lens. Each refuses a path outside the repository with `OutsideRepositoryError`, refuses symlinks, passes `--literal-pathspecs` so a `*` in a file name is that character, and bounds its output by `revisionLimits`.

Unlike the policy source, these truncate rather than fail at a bound. A lens asked to read a 2 MB generated file should see its first 256 KiB and a note, not an error it cannot recover from; policy, by contrast, must never be silently cut.

## Model routing

`resolveModelForTier(tier, config.models)` returns the tier's model and fallbacks as `{ provider, modelId }` references, splitting `provider/model-id` at the first slash so an OpenRouter ID such as `openrouter/anthropic/claude-sonnet-4-5` keeps its own slash. A tier with no model is a `ModelRoutingError` naming the tier. Choosing among the fallbacks needs credentials, so the pipeline does it.

## Findings

### Schema

A `Finding` is a SARIF 2.1.0 `result`. SARIF forbids unknown keys on a result, so Melian's extensions (`id`, `cause`, `trigger`, `severity`, `confidence`, `resolution`, `status`, `explanation`, `source`) live in its `properties` bag. The bag rejects unknown keys too, so a misspelt optional key such as `confidance` fails instead of vanishing. `test/findings.test.ts` validates a log against the OASIS schema in `test/fixtures/sarif-schema-2.1.0.json`; keep that test passing whenever the schema changes.

- Build findings with `createFinding`, which derives the level and the ID, and validate any finding read from outside with `parseFinding`. It rejects a level or an ID that disagrees with the rest of the finding.
- Never store `undefined` in a finding. JSON drops it, so a round trip would change the value. `createFinding` leaves absent optional fields out.
- `trigger` is optional: a pre-existing finding has no triggering hunk.

### Level mapping

`levelForSeverity` maps `P0` and `P1` to `error`, `P2` to `warning`, and `P3` and `nit` to `note`. Melian never emits `none`, which SARIF reserves for results that are not failures. The mapping follows the default resolution, so GitHub code scanning shows blocking findings as errors. It ignores a repository's resolution configuration on purpose: `level` says how serious a finding is, and `properties.resolution` says what it requires.

### Stable IDs

`findingId` hashes the repository-relative path, the rule ID, and the snippet, joined by NUL, with sha256, and keeps the first 16 hex characters. Before hashing it trims the snippet and collapses every run of whitespace to one space. Line numbers are not an input.

Problem: cross-revision diffing and dismissals match findings by ID, so the ID must survive edits that leave the flagged code alone. Example: a commit adds an import at the top of `src/run.ts`, and `eval(input)` moves from line 12 to line 13. A line-keyed ID would call that a new finding and reopen a dismissed one. Solution: hash what the finding is about, not where it sits. Reindenting or rewrapping the snippet keeps the ID; changing one token, such as `eval(input)` to `eval(body)`, changes it, and so does moving the code to another file.

The normalisation is a stored contract. Changing it orphans every recorded finding and dismissal, so `test/findings.test.ts` pins one ID by value. Change that value only in a change that migrates stored findings.

### Cause by location, for now

`classifyCause` decides a finding's cause from where it sits. A location overlapping any hunk's new lines is `introduced`; one elsewhere in a changed file is `affected`; one in an unchanged file is `pre-existing`.

This is a placeholder. The design classifies cause by evidence through the decision model, which arrives later. Until then the heuristic is wrong in both directions: a renamed parameter breaks a caller in an unchanged file, which the heuristic calls `pre-existing`, and an old bug three lines below a hunk is called `affected`. A lens that cites the change it broke, or shows that it did not, may override the heuristic's answer.

A pure deletion has no new lines, so nothing is inside it. Code beside a deletion is `affected`, and the lens must say why.

### Rendering

`renderFindingsJson` writes the SARIF log; `renderFindingsTerminal` writes plain text grouped by file in path order, and within a file by severity, then line, then ID. The terminal output carries no escape codes unless `color` is set, so a pipe or a log file receives plain text. Hosts decide whether to colour; core never reads `isTTY` or `NO_COLOR`.

Finding text is untrusted: a lens writes it after reading the change under review, which anyone opening a pull request controls. The terminal renderer strips control characters, so a finding cannot clear the author's screen or retitle their terminal, and indents continuation lines so a multi-line explanation stays inside its block. Any new renderer for a terminal does the same.

## Tests

- Run the package's tests with `npm test --workspace @melian-agent/core`, or one file with `npx vitest --run packages/core/test/changeset.test.ts` from the repository root.
- Build real repositories in a temporary directory in `beforeEach` with `test/fixtures/repo.ts`, and delete them in `afterEach`. Never mock git.
- Isolate git from the developer's configuration. `isolatedGitEnv` points `GIT_CONFIG_GLOBAL` at `/dev/null` and sets an author; without it, a developer who signs commits sees every fixture commit fail. Stub the same variables into `process.env` while code under test runs git.
- Take temporary directories through `temporaryDirectory()`, which resolves symlinks. On macOS the system temporary directory is a symlink, and git reports the resolved path, so a comparison with the unresolved one fails.
- Assert exact hunk ranges against a diff small enough to check by eye.
- Golden files live in `test/golden/`, compared with Vitest's `toMatchFileSnapshot`. A mismatch fails the gate. After a deliberate change, regenerate with `npx vitest --run -u packages/core/test/render.test.ts` and read the diff before committing. They use `.sarif` and `.txt` extensions, which Biome does not format.
- Run every loader test against both sources with `describe.each(sourceKinds)`. `sourceFor(root, kind)` commits the working tree for a revision, so one body checks that the two agree. Test what only a revision guarantees, such as ignoring the checked-out branch, in a block of its own.
- Await a rejection with `rejection(promise, ErrorClass)`, which fails unless the promise rejects with that class and returns the error typed.
