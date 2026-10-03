# Core guidelines

The core package holds the review domain: changesets, configuration, standards, and later findings, lenses, and checks. Everything in it runs without a harness, so a unit test needs nothing but Node, git, and a temporary directory.

## Harness-free

Core imports nothing from Pi Durable, Chord, or another Melian package. The design permits pi-ai's types; nothing needs them yet. `packages/core/test/harness-free.test.ts` fails the gate if core imports Pi or a Melian package, and so does the pipeline's `test/harness-boundary.test.ts` for Pi. Both match every import form, `from`, a side-effect `import "x"`, `import()` with any quote, and `require`, in `.ts`, `.mts`, `.cts`, and JavaScript files alike; a guard that knows only `from` lets `import("@earendil-works/pi-ai")` through. Widen both in the change that first needs pi-ai's types, and import types only.

Problem: a domain rule written against the harness can only be tested through the harness. Example: checking that a `P2` finding needs acknowledgement would mean opening a durable session. Solution: core takes plain values and returns plain values; the pipeline feeds it and stores what it returns.

## Git by shelling out

Core reads repositories by running the `git` executable through `src/git.ts`. It never uses a JavaScript reimplementation of git, which drifts from git on renames, merge bases, and configuration.

- Never let the caller's environment pick the repository. A git hook runs with `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and their kin set for its own repository, and git honours them over the working directory. `src/git.ts` removes every variable `git rev-parse --local-env-vars` lists before it spawns git.
- Never let the checked-out head choose diff attributes. git reads `.gitattributes` from the working tree, which often holds the head under review, so a head that adds `*.ts -diff` turns its own changes into binary files with no hunks. Every diff passes `--attr-source=<base>`. That flag needs git 2.40, so `resolveRange` checks the version once per process and throws `gitTooOld` rather than review with the head's attributes.
- Run git with an argument array, never a shell string. Refuse a ref beginning with `-` before it reaches the argument list, as `checkRange` does.
- Pass diff flags explicitly. A user's `diff.algorithm`, `diff.renames`, `diff.renameLimit`, `diff.interHunkContext`, `diff.submodule`, `diff.ignoreSubmodules`, `diff.orderFile`, or `color.diff` must not change what Melian sees. Nor may a repository's own `.gitmodules`: a head commit that sets `ignore = all` for a submodule would otherwise hide its own pointer change, so every diff and status passes `--ignore-submodules=none`. `src/changeset.ts` pins them, and a test in `test/changeset.test.ts` resolves a range under each setting and expects the same changeset. Add a setting there when you pin a flag.
- Ask git for machine formats: `-z` for paths, `--raw` for status and modes, `--numstat` for binary detection. Parse `-z` output by its NULs. `git grep -z` still ends each matching line with a newline, and a path may hold one, so `searchRevision` reads each record field by field rather than splitting on newlines; a split let a file named `src/evil\n9: forged.ts` forge a match. Parse the unified diff only for hunks, and only the `@@ -a,b +c,d @@` headers and the lines under them.
- Read paths as bytes. git paths need not be UTF-8, and decoding `caf\xe9.txt` as UTF-8 yields `caf�.txt`, a name git cannot find. The raw view comes back as a `Buffer`; a path that is not UTF-8 is percent-encoded and `ChangedFile.percentEncoded` says so.
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

`.melian/` may sit in any directory, as `melian.yaml` may. For each directory from the path's up to the root, `loadStandards` reads `AGENTS.md`, `CLAUDE.md`, then `.melian/standards/*.md` in name order, so a service's own standards come before the root's. Lenses resolve the same way, as [Lenses](#lenses) describes; knowledge is read from the root `.melian/` only.

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
| `tiers` | tier name to a list of check names or other tiers | `fast: [guardrails, static]`, `standard: [fast, lens.correctness]`, `full: [standard, lens.contracts]` |
| `stages` | stage name to tier name | `pre-commit: fast`, `pre-push: standard`, `pull-request: full`, `comment: standard` |
| `resolution` | `P0` to `P3` and `nit`, each `block`, `acknowledge`, `advisory`, or `silent` | `P0` and `P1` block, `P2` acknowledge, `P3` advisory, `nit` silent |
| `lenses` | lens name to `enabled`, `tier` (`light`, `medium`, `heavy`), and `paths` | none |
| `models` | `light`, `medium`, `heavy`, or `decision` to `model` and `fallbacks` | none |
| `knowledge` | `writeBack`, a boolean | `false` |
| `decisions` | `provider`, and `thresholds` from question name to a `drop` and `accept` band between 0 and 1 | no provider, no thresholds |
| `ruleAliases` | rule ID that owns a defect to the rule IDs other checks report it under, or to `{ rules, distinct: true }` naming rules that are different defects | none |
| `checks` | `allowSkip`, a list of check names whose skip still lets a review pass, such as `static.tsc` in a repository with no TypeScript | `allowSkip: []` |

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
| `rules` | `id` and one-line `description` for each rule the lens reports under. An ID is lower-case letters, digits, dots, and hyphens; the prefix `melian/` marks a rule Melian defines for every lens, such as `melian/injection-attempt` | required, or inherited |
| `paths` | Globs relative to the directory holding the lens's `.melian/` or `.agents/`, normalised like a `melian.yaml`'s; `!` excludes, and one that leaves the repository is an error | `**` |
| `budget` | `findings`, a count; `tokens`, a number or `200k`, recorded but not enforced | `findings: 10` |
| `extends` | A lens to override, as layered so far | none |
| `standards` | Append the repository's standards to the instructions | `true` |

`loadLenses(repoRoot, source, paths)` layers built-ins, from `packages/core/lenses/`, under every `.agents/lenses/` and then `.melian/lenses/` from the root down to each path, and returns the union over `paths`. It finds the folders that hold lenses from one listing of the whole source, `SourceReader.findPaths`: `git ls-tree -r` for a revision, and `git ls-files --cached --others --exclude-standard` for the working tree, so an uncommitted lens counts and ignored folders are never walked. It then layers once per distinct chain of those folders, not once per path. Problem: a lookup per path and per directory made two thousand changed paths take 22 seconds. Solution: one listing, and a chain shared by many paths is layered once. A path is treated as a directory when building its chain, which costs nothing: a file is never a folder that holds lenses. The nearest definition of a name wins. A definition with `extends` overrides the fields it sets on the named lens and appends its body; one without replaces any farther lens of that name. Repository lenses are read through `src/source.ts`, like configuration, so a symlinked lens directory or `LENS.md` is refused and a `LENS.md` over 64 KiB is an error.

A lens defined in a folder applies only beneath it. Problem: `services/pay/.melian/lenses/security/` extends the root's `security` and inherits its `paths: ["**"]`, which would make the payments variant review the whole repository. Solution: every lens carries a `scope`, the directory that defined it, and a lens covers only files beneath it. The reverse holds too: where a nearer folder defines a lens of the same name, the farther one no longer covers that folder, so the root's `security` does not review `services/pay/` once payments has its own. That holds even when no changed file lies beneath `services/pay/`: `loadLenses` records on each lens, as `nearer`, every folder in the whole source that defines its name, and `selectLenses` adds those to the coverage. Built only from the lenses the changed paths reached, the root's lens would accept a finding in `services/pay/` whenever the change touched nothing there. `nearer` is not part of `version`. `selectLenses` returns each selected lens with its `coverage` and the changed files it reviews, and `lensCovers` answers for any path, so the pipeline can refuse a finding outside it. Two variants of one name can then run on one changeset, each over its own folder; `version`, a hash of everything that shapes the lens, tells their findings apart.

`renderLensInstructions(lens, standards)` builds a lens conversation's instructions: the body, then a fixed block listing every rule as `` `id`: description ``, the severities the lens may report, and its findings budget, then the repository's standards unless the lens opts out. Problem: the rules lived only in front matter, so the model guessed rule IDs; in the first live run three of the four lenses that reported anything opened with a rule the hook refused, a wasted round each. Solution: the model reads the exact IDs.

`selectLenses(lenses, config, paths)` applies `melian.yaml`'s `lenses` settings: `enabled: false` drops a lens, `tier` retiers it, and `paths` replaces its globs. `**` matches dotfiles, unlike Node's `path.matchesGlob`, so a lens over `**` sees `.github/workflows/`.

## Reading the head revision for lenses

`readRevisionFile`, `listRevisionFiles`, and `searchRevision` in `src/revision.ts` back the lens tools. They read a commit through `git ls-tree`, `git cat-file`, and `git grep`, never the working tree, so an uncommitted edit or untracked file is invisible to a lens. Each refuses a path outside the repository with `OutsideRepositoryError`, refuses symlinks, passes `--literal-pathspecs` so a `*` in a file name is that character, and bounds its output by `revisionLimits`. `searchRevision` also takes `attributesFrom`, the commit whose `.gitattributes` decide which files `git grep -I` skips as binary, and passes it as `--attr-source`; the lens tool passes the review's base, as the diff does. Without it git reads the checkout's attributes, and a head that adds `*.ts -diff` hides its own TypeScript from search.

Unlike the policy source, these truncate rather than fail at a bound, and `readRevisionFile`'s bound, `revisionLimits.fileBytes`, is 8 MiB. Problem: a 256 KiB bound cut a 10,000-line file, so its tail could be neither read nor reported. Solution: read the whole blob, up to a cap no reviewed source file reaches, and let each tool bound what it shows per call. Past 8 MiB a lens sees the first part and a note, not an error it cannot recover from; policy, by contrast, must never be silently cut.

## Model routing

`resolveModelForTier(tier, config.models)` returns the tier's model and fallbacks as `{ provider, modelId }` references, splitting `provider/model-id` at the first slash so an OpenRouter ID such as `openrouter/anthropic/claude-sonnet-4-5` keeps its own slash. A tier with no model is a `ModelRoutingError` naming the tier. Choosing among the fallbacks needs credentials, so the pipeline does it.

## Findings

### Schema

A `Finding` is a SARIF 2.1.0 `result`. SARIF forbids unknown keys on a result, so Melian's extensions (`id`, `path`, `occurrence` or `discriminator`, `cause`, `evidence`, `trigger`, `severity`, `confidence`, `resolution`, `status`, `explanation`, `source`, `reportedBy`) live in its `properties` bag. The bag rejects unknown keys too, so a misspelt optional key such as `confidance` fails instead of vanishing. So does every SARIF object Melian models: the result, its message, location, physical location, artifact location, region, and snippet, and the log, run, tool, and driver around them. Each lists the standard members Melian supports and nothing else, so a result supplied from outside with a member Melian does not understand, such as `kind` or `region.byteOffset`, is rejected before it reaches storage rather than stored and silently dropped later. Support a new SARIF member by adding it to the schema. `test/findings.test.ts` validates a log against the OASIS schema in `test/fixtures/sarif-schema-2.1.0.json`; keep that test passing whenever the schema changes.

- Build findings with `createFinding`, which derives the level and the ID, and validate any finding read from outside with `parseFinding`. It rejects a level or an ID that disagrees with the rest of the finding.
- Every finding carries its ID as `partialFingerprints["melian/v1"]`, and `parseFinding` rejects a fingerprint that differs. GitHub code scanning matches alerts across uploads by partial fingerprints; without one it falls back to its own hash of the line, so a line shift closes one alert and opens another. Bump the key's version only with a change that migrates stored IDs.
- `createFindingsLog` lists each rule once in `tool.driver.rules`, sorted by ID, and gives each result the `ruleIndex` of its rule. GitHub reads rule metadata from there. `ruleIndex` belongs to a log, not a finding, so a stored finding has none and `parseFinding` rejects one.
- A region may not end before it starts: an `endLine` before `startLine`, or on one line an `endColumn` before `startColumn`, throws `FindingError` `invalidRegion`.
- Never store `undefined` in a finding. JSON drops it, so a round trip would change the value. `parseFinding`, and so `createFinding`, returns a copy with every `undefined`-valued key removed at any depth, so a nested `trigger.snippet: undefined` neither fails as a `TypeError` in storage nor makes the stored copy differ from the value in hand.
- `reportedBy` lists every producer that reported the finding at one head, when the pipeline merged several sightings of its ID. `source` names the one whose record won.
- `trigger` names the hunk that caused the finding by its `file` and `index`, as a `Hunk` names itself, rather than copying its line ranges. It is optional: a pre-existing finding has no triggering hunk. Its optional `snippet` is the changed code as the producer saw it; the pipeline reopens a dismissed finding when that code's `normaliseSnippet` changes.

### Paths and URIs

SARIF's `artifactLocation.uri` is a URI reference, not a path. Problem: git allows almost any byte in a file name, and `docs/release notes.md` or `src/100%.ts` copied into `uri` is not a valid URI, so a strict SARIF consumer rejects the whole log, and a `#` or `?` silently truncates the path. Solution: `createFinding` percent-encodes each path segment with `encodeURIComponent` and joins the segments with `/`, so `src/café/why?.ts` becomes `src/caf%C3%A9/why%3F.ts`. To decode, split the URI on `/` and apply `decodeURIComponent` to each segment. The raw repository-relative path stays in `properties.path` for consumers that want it, and is what `findingId` hashes, so encoding never changes an ID. `parseFinding` rejects a URI that does not encode `properties.path`. A path that is not UTF-8 arrives from the changeset already percent-encoded, with `ChangedFile.percentEncoded` set; `properties.path` keeps that form, so its `%` is encoded again as `%25` in the URI, and decoding the URI gives back the changeset's path.

A path is canonical: repository-relative, posix, with no empty or `.` segments. Problem: IDs, the findings document, and `classifyCause` compare paths as strings, so `./src/run.ts` and `src/run.ts` were two files with two IDs, and a finding at `./src/run.ts` never matched the changeset's `src/run.ts`. Solution: `createFinding` canonicalises the location's and the trigger's file, so `./src//run.ts` becomes `src/run.ts`, and `classifyCause` canonicalises before comparing. Both throw `FindingError` `invalidPath` for an empty or absolute path, one with a `..` segment, or one with a backslash, which is a Windows separator more often than a file name character. `parseFinding` refuses a stored path that is not already canonical.

### What a lens reports

`reportFindingInputSchema` is the lens-facing schema for step 5's `report_finding` tool, and holds exactly `file`, `line`, an optional `endLine`, `rule`, `severity`, `explanation` (`what`, `why`, `fix`), and an optional `evidence` of `file`, `line`, and an optional `endLine`. Every object in it rejects other keys, and a string is not evidence. `FindingInput` stays the internal type that `createFinding` takes.

Problem: a finding's ID hashes its rule and snippet, so if the model supplies them, identity depends on its wording. Example: one run reports `eval(input)` under `no-eval`, the next copies the snippet as `eval( input );` under `unsafe-eval`, and the dismissed finding returns as new. A lens that also chose `resolution`, `cause`, or `status` could unblock its own findings. Solution: the lens supplies only what needs judgement, and Melian derives the rest.

- The snippet is the head revision's text at the reported lines, read through the revision source with `git show`, never taken from the model. `snippetOccurrence` on that file then gives the occurrence.
- `rule` must be one of the rules the lens declares in its front matter's `rules` list, which step 5 adds; the hook rejects any other.
- `source` is the lens's identity and version.
- `cause` is `classifyCause` of the location, made `affected` only by `evidence`, a location in the changed code that provably breaks it. `checkEvidence` accepts it only when the file is changed and the lines overlap a hunk's new lines, and the snippet stored with it is read from the head.
- `resolution` is left out. Only adjudication, step 7, writes it, from configuration and the cause, so a producer never decides what blocks. `findingPropertiesSchema` makes it optional, and the terminal renderer prints `unresolved` for a finding without one.
- `status` comes from the findings document.

### Level mapping

`levelForSeverity` maps `P0` and `P1` to `error`, `P2` to `warning`, and `P3` and `nit` to `note`. Melian never emits `none`, which SARIF reserves for results that are not failures. The mapping follows the default resolution, so GitHub code scanning shows blocking findings as errors. It ignores a repository's resolution configuration on purpose: `level` says how serious a finding is, and `properties.resolution` says what it requires.

### Stable IDs

`findingId` hashes the repository-relative path, the rule ID, the snippet, and a discriminator with sha256, and keeps the first 16 hex characters. Each field enters the hash as its length in UTF-16 code units, a colon, and the field, so no character in one field, NUL included, can make two different findings hash alike: joining by NUL let `a\0b` and `b` collide with `a` and `b\0b`. Before hashing it normalises the snippet with `normaliseSnippet`, described below. Line numbers are not an input.

Problem: cross-revision diffing and dismissals match findings by ID, so the ID must survive edits that leave the flagged code alone. Example: a commit adds an import at the top of `src/run.ts`, and `eval(input)` moves from line 12 to line 13. A line-keyed ID would call that a new finding and reopen a dismissed one. Solution: hash what the finding is about, not where it sits. Reindenting or rewrapping the snippet keeps the ID; changing one token, such as `eval(input)` to `eval(body)`, changes it, and so does moving the code to another file.

The normalisation, exactly: walk the snippet by code point; drop every whitespace character (`\s` with the Unicode flag); where one or more were dropped between two word characters, emit one space instead. A word character is a letter, combining mark, or digit in any script (`\p{L}`, `\p{M}`, `\p{N}`), `_`, or `$`; everything else that is not whitespace is punctuation. So `foo(a, b)` and the same call wrapped one argument per line both become `foo(a,b)`, a call chain rewrapped one method per line becomes the one-line chain, and `return   x` becomes `return x`. Collapsing runs of whitespace was not enough: a formatter that wraps `foo(a, b)` puts a newline after `(`, where the one-line form has no space at all, so the ID changed on every rewrap. The cost is that `a - -b` and `a-- b` normalise alike, which is accepted. A formatter that also adds or removes a token, such as a trailing comma, still changes the ID.

Hashing only the snippet makes identical code collide. Example: `src/run.ts` calls `eval(input)` on lines 12 and 40, and a lens reports both. Both get one ID, and the second silently replaces the first in the findings document. Solution: the discriminator. With a snippet it is the occurrence, the zero-based ordinal of that normalised snippet among identical ones in the file at head, in line order; `snippetOccurrence` counts it from the file's text, and a column tells two on one line apart. Edits elsewhere and line shifts keep it. Inserting another `eval(input)` above line 12 renumbers both, which is accepted: the alternative is a line-keyed ID. A finding without a snippet must supply its own discriminator, such as the enclosing symbol or the hunk index; `createFinding` throws `FindingError` `missingDiscriminator` otherwise, rather than guess. The finding stores whichever it used as `properties.occurrence` or `properties.discriminator`, so `parseFinding` can recompute the ID.

The normalisation and the hash input are a stored contract. Changing either orphans every recorded finding and dismissal, so `test/findings.test.ts` pins two IDs by value, one of them for a real formatter rewrap. Change those values only in a change that migrates stored findings.

### Cause by location, for now

`classifyCause` decides from where a finding sits whether location alone proves its cause. A location in an added file, or overlapping any hunk's new lines, is `introduced`; an added binary file has no hunks, so the file's status decides. Every other location is `pre-existing`: elsewhere in a changed file, in an unchanged file, or beside or across a pure deletion, which has no new lines. A file deleted at head has no lines to point at, so `classifyCause` throws `FindingError` `deletedFile` rather than classify a location that cannot exist.

Location never proves `affected`. Problem: an earlier heuristic called anything in a changed file but outside its hunks `affected`, and `affected` can block. Example: a pull request fixes a typo on line 3 of `src/db.ts`, and a lens notices a SQL injection on line 80 that predates it. The heuristic made the old injection a blocker on an unrelated typo fix. Solution: `affected` needs evidence. `createFinding` makes a finding `affected` only through `cause: { evidence }`, where `evidence` is `FindingEvidence`: the `file`, `startLine`, optional `endLine`, and `snippet` of the changed code that provably breaks the location, such as `src/api.ts:3`, `export function load(userId: string) {`. It stores it in `properties.evidence` with a canonical path, and `parseFinding` throws `missingEvidence` for an `affected` finding without it, `invalidFinding` for evidence on any other cause, and `invalidRegion` for evidence that ends before it starts. No heuristic produces evidence.

Evidence is a location, never prose. Problem: free-text evidence let a sentence make a finding `affected`, and nothing checked that the cited code was changed. Solution: `checkEvidence(location, revision)` returns the hunk whose new lines the location overlaps, and throws `FindingError` `invalidEvidence` otherwise, with a message saying what evidence must be. `createFinding` takes plain values and cannot see the changeset, so the caller runs `checkEvidence` first and reads the snippet from the head, as the pipeline's `report_finding` does.

The cost is the other direction: a renamed parameter that breaks a caller is `pre-existing` until the lens cites the rename. Missing breakage is recoverable; blocking on an old defect teaches authors to ignore Melian. The design classifies cause through the decision model later, which may promote a finding with evidence but never without.

### Rendering

`renderFindingsJson` writes the SARIF log; `renderFindingsTerminal` writes plain text grouped by file in path order, and within a file by severity, then line, then ID. The terminal output carries no escape codes unless `color` is set, so a pipe or a log file receives plain text. Hosts decide whether to colour; core never reads `isTTY` or `NO_COLOR`.

Given a `Verdict` instead of a log, `renderFindingsTerminal` leads with the status and whether it blocks, lists the checks that did not run with their reasons and errors, then prints the `block`, `acknowledge`, and `advisory` groups in that order, each grouped by file as above. Silent and dismissed findings are counted, not printed. Check names, reasons, and errors are escaped like finding text: a provider's error message is no more trusted than a lens's. `renderVerdictJson` writes the verdict as JSON, its findings as SARIF results.

Everything the renderer prints is untrusted. A lens writes finding text after reading the change under review, which anyone opening a pull request controls, and that author also chooses the file paths. Example: a file named `src/run.ts` followed by ESC `[2J` clears the reviewer's screen, a newline in a path or rule ID forges a second header, and a right-to-left override makes `gnp.ts` read as `ts.png`. The terminal renderer therefore prints every control character, C1 control, line or paragraph separator, and bidi control in every string, paths and rule IDs included, as a visible `\uXXXX`, with colour on or off. Prose keeps its newlines as indented continuation lines, so a multi-line explanation stays inside its block; a newline anywhere else is escaped. Every continuation line sits deeper than any header it could imitate. A message's first line shares a finding header's two-space indent, so its later lines take four spaces and a `| ` marker: at two spaces, a message line reading `P0  line 1  no-eval` passed for a finding of its own. Any new renderer for a terminal does the same. `visibleText` is that escaping, exported so the pipeline applies it to every path it puts in a prompt.

## Adjudication

Adjudication turns the findings a review collected into what the change requires. It is plain functions over plain values, in `src/adjudication.ts`; the pipeline loads configuration and stores the result.

### Resolution

`resolveFinding(finding, config)` returns what a finding requires under `config`, the effective configuration at the finding's path: `config.resolution` for its severity. `applyResolutions(findings, configFor)` returns copies with `properties.resolution` set, each under `configFor(path)`, so a nested `melian.yaml` that lowers `P2` to `advisory` for `docs/` applies to findings in `docs/` and nowhere else. `configFor` is synchronous: load the configuration for each path first, with `loadConfig`.

A finding the change did not cause is never above `advisory`. Problem: severity says how bad a defect is, not whether this change made it. Example: a lens notices a `P0` SQL injection on line 80 of a file whose typo on line 3 the change fixed; at the configured `block`, the typo fix could not merge. Solution: a `pre-existing` finding resolves to the lesser of its configured resolution and `advisory`, so a `nit` stays `silent`. An `introduced` finding keeps its configured resolution, and so does an `affected` one, only because it carries evidence; `affected` without evidence is treated as `pre-existing`.

A producer stores no resolution, and an absent one means not yet adjudicated, never `silent`. `resolveFinding` decides from severity, cause, and evidence, and ignores any resolution a finding carries; `applyResolutions` replaces it. `adjudicate` groups every finding by the resolution it computes, so none is dropped or silenced for lacking one. Its findings are `ResolvedFinding`s, whose type requires the resolution.

### Dedupe across sources

The findings document holds one finding per ID, and the rule is part of the ID, so two checks that file one defect under two rules produce two findings. Example: the first live golden run, recorded in `packages/evals/runs/2026-10-03-live-goldens.md`, had the contracts lens report `src/cart.ts:10` as `broken-caller` and the correctness lens report the same line as `unhandled-error`; ESLint and the security lens do the same with `security/detect-eval-with-expression` and `no-eval`. The author would read each defect twice.

`dedupeFindings(findings, configFor)` treats two findings as one defect when different checks report them in the same file, on the same normalised snippet at the same occurrence, over overlapping lines, whatever their rules. Findings from one check never merge: a lens that reports two rules on one line means two defects.

One finding speaks for each defect. `ruleAliases` decides first: a key names the rule that owns a defect, and its list the rules other checks file it under.

```yaml
ruleAliases:
  broken-caller: [unhandled-error]
  no-eval: [security/detect-eval-with-expression, lint/security/noGlobalEval]
```

With that table, the contracts lens's `broken-caller` speaks for the defect above. Without an owner among the defect's rules, the most severe finding speaks, the lower ID on a tie. A finding without a snippet never merges, and there is no fuzzy matching: a static tool that flags `eval(input)` and a lens that flags the three lines around it have different snippets and stay two findings.

A merge never lowers what blocks. Problem: the speaker kept its own cause. Example: the correctness lens reports `src/cart.ts:10` as a `P0` with no evidence, so `pre-existing`, and the contracts lens reports it as a `P1` citing the changed signature in `src/price.ts`, so `affected`. The `P0` spoke, stayed `pre-existing`, and resolved to `advisory`; the evidenced blocker vanished. Solution: the speaker takes the highest severity any member reported, with its level to match, and `strongestCause` of the members: `introduced` over `affected` over `pre-existing`, with the evidence of the most severe member that has the winning cause. It lists each other finding's ID, rule, and check in `properties.alsoReportedAs`. The pipeline's merge of sightings by ID, in `readFindings`, applies `strongestCause` too.

Only findings with the same lifecycle status merge. Problem: dedupe ignored status, so the speaker's status became the defect's. Example: an author dismisses the security lens's `P3` under `no-eval`, which `ruleAliases` names as the owner, and ESLint reports the same `eval(input)` as a `P0` under its own rule; the merged finding was the dismissed `P3`, and the `P0` blocked nothing. Solution: a dismissed finding never absorbs a live one. The live finding stays live and blocks if it blocks, and lists the dismissed one in `alsoReportedAs`, so the author sees that the defect was answered once under another rule.

The merge is general on purpose, and that has a cost. Two distinct defects on one expression, such as a null dereference and an unhandled rejection on the same call, collapse into one finding that lists both rules in `alsoReportedAs`. That is accepted: the live runs showed one defect filed under different rules by different lenses far more often, and a merge that waited for an alias would hide nothing but show every such defect twice. `ruleAliases` is how a repository says two rules are different defects. An entry with `distinct: true` lists rules that never merge with its key, in either direction:

```yaml
ruleAliases:
  null-dereference:
    rules: [unhandled-error]
    distinct: true
```

### The verdict

`adjudicate({ findings, manifest, checks, config, allowSkip })` dedupes, resolves, and returns a `Verdict`: a `status`, a `blocking` flag, the findings grouped by resolution (`block`, `acknowledge`, `advisory`, `silent`), the `dismissed` findings, and `notRun`, every check that was skipped or failed with its reason. `config` is one configuration for every path or a `ConfigFor` function.

The status has three states, because a check that reports green while the review never ran is the incumbent failure the design names:

- `not-reviewed` when any check failed, was skipped and is not in `allowSkip`, or is in the manifest with no record. This holds with zero findings: a lens that crashed found nothing because it looked at nothing.
- `findings` when every check ran and a finding resolves above `silent`.
- `passed` otherwise. An allowed skip does not stop a pass.

`blocking` is true whenever a finding resolves to `block`, in every status, so a host can say a review both blocks and is incomplete. A dismissed finding counts toward neither: dismissing with a reason is how an author answers an `acknowledge`.

`checks` is a list of `CheckRecord`s, `{ name, status: "ran" | "skipped" | "failed", reason?, error?, version? }`, with names as the tiers spell them, such as `lens.security` or `static.biome`. The lens task writes one per lens; static analysis and guardrails, step 6, write theirs in the same shape. `version` is the version of the tool that ran, as its findings' `source.version` names it. `allowSkip` names checks whose skip is expected, such as a type checker on a change with no TypeScript; a repository sets it as `checks.allowSkip` in `melian.yaml`, and the pipeline passes it on. It never excuses a check of the manifest that left no record.

The manifest is the tier's check list, and every check in it must account for itself. Problem: `checks` was optional and nothing said what it should hold, so a required check that never started left no record and no trace. Example: a pull request reviewed under `full` with the lenses passing and no Biome record read `passed`, though Biome never ran. Solution: `manifest` is required, and every name in it without a record joins `notRun` as `skipped` with the reason `no record`, which `allowSkip` cannot excuse. A record outside the manifest still counts, so a failed check a host ran anyway is never hidden.

`checksOfTier(config, tier)` expands a tier into its manifest: a name that is itself a tier expands to that tier's checks, in order and without repeats. It throws `CheckError` `unknownTier` or `tierCycle`. It does not expand `static` into the static tools; [pull request #18](https://github.com/melian-agent/melian/pull/18) adds that group with its runners, and the two versions are reconciled when it lands.

## Tests

- Run the package's tests with `npm test --workspace @melian-agent/core`, or one file with `npx vitest --run packages/core/test/changeset.test.ts` from the repository root.
- Build real repositories in a temporary directory in `beforeEach` with `test/fixtures/repo.ts`, and delete them in `afterEach`. Never mock git.
- Isolate git from the developer's configuration. `isolatedGitEnv` points `GIT_CONFIG_GLOBAL` at `/dev/null` and sets an author; without it, a developer who signs commits sees every fixture commit fail. Stub the same variables into `process.env` while code under test runs git.
- Take temporary directories through `temporaryDirectory()`, which resolves symlinks. On macOS the system temporary directory is a symlink, and git reports the resolved path, so a comparison with the unresolved one fails.
- Assert exact hunk ranges against a diff small enough to check by eye.
- Golden files live in `test/golden/`, compared with Vitest's `toMatchFileSnapshot`. A mismatch fails the gate. After a deliberate change, regenerate with `npx vitest --run -u packages/core/test/render.test.ts` and read the diff before committing. They use `.sarif`, `.json`, and `.txt` extensions, which Biome does not format: its `files.includes` lists only code.
- Run every loader test against both sources with `describe.each(sourceKinds)`. `sourceFor(root, kind)` commits the working tree for a revision, so one body checks that the two agree. Test what only a revision guarantees, such as ignoring the checked-out branch, in a block of its own.
- Await a rejection with `rejection(promise, ErrorClass)`, which fails unless the promise rejects with that class and returns the error typed.
