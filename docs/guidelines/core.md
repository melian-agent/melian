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
- Ask git for machine formats: `-z` for paths, `--raw` for status and modes, `--numstat` for binary detection. Parse the unified diff only for hunks, and only the `@@ -a,b +c,d @@` headers and the lines under them.
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
| `static` | `biome` and `tsc`, each with `enabled`, `timeout` in seconds, and `severity` from a Melian rule ID to a severity; `tsc` also takes `project` | both enabled, 300 seconds, no overrides, `project: tsconfig.json` |
| `guardrails` | `forbidden-paths`, `required-files`, `forbidden-patterns`, each with `enabled`, `severity`, and `rules` by name; `policy-change-review` with `enabled`, `severity`, and `files`, globs added to the built-in policy and tool configuration files | all enabled, no rules, no extra files; severity `P1` for forbidden-paths, `P2` for the others |
| `knowledge` | `writeBack`, a boolean | `false` |
| `decisions` | `provider`, and `thresholds` from question name to a `drop` and `accept` band between 0 and 1 | no provider, no thresholds |

Guardrail rules follow lenses: a map keyed by rule name, each field optional in one file, so a nearer file can restate one field of a root rule. A merged rule missing a field is an error naming the nearest file that set the rule. Each glob in a required-files rule's `require` must be matched by a touched path on its own, so a `!` exclusion there is a `ConfigError` `invalidValue` naming the file and key; evaluated alone, `!docs/drafts/**` could never be satisfied and the rule would always fire. Narrow the positive glob instead. Guardrail globs anchor to their file like a lens's `paths`: `forbidden-paths.rules.*.paths`, `required-files.rules.*.when` and `require`, and `forbidden-patterns.rules.*.paths`. `static` is read from the configuration the host passes for the repository root, since each tool runs once over the whole tree.

Lenses are a map keyed by name rather than `enable` and `disable` lists, so that layering works per lens: a service can disable one lens without restating the root's list. A band layers like any object, so a nearer file may restate only `drop` or only `accept`. A merged band missing either end, or whose `drop` exceeds its `accept`, is an error naming the nearest file that set it.

Unknown keys are errors that name the key and the file, because a misspelt key otherwise falls back to a default without a word.

A `__proto__` key anywhere is a `reservedKey` error. Problem: `lenses: { __proto__: { tier: heavy } }` merged into a plain object replaces its prototype, so every lens no file configures appears to have `tier: heavy`. Solution: the loader refuses the key, and builds merged objects with no prototype, so a lens named `constructor` or `toString` is looked up like any other.

## Findings

### Schema

A `Finding` is a SARIF 2.1.0 `result`. SARIF forbids unknown keys on a result, so Melian's extensions (`id`, `path`, `occurrence` or `discriminator`, `cause`, `evidence`, `trigger`, `severity`, `confidence`, `resolution`, `status`, `explanation`, `source`) live in its `properties` bag. The bag rejects unknown keys too, so a misspelt optional key such as `confidance` fails instead of vanishing. So does every SARIF object Melian models: the result, its message, location, physical location, artifact location, region, and snippet, and the log, run, tool, and driver around them. Each lists the standard members Melian supports and nothing else, so a result supplied from outside with a member Melian does not understand, such as `kind` or `region.byteOffset`, is rejected before it reaches storage rather than stored and silently dropped later. Support a new SARIF member by adding it to the schema. `test/findings.test.ts` validates a log against the OASIS schema in `test/fixtures/sarif-schema-2.1.0.json`; keep that test passing whenever the schema changes.

- Build findings with `createFinding`, which derives the level and the ID, and validate any finding read from outside with `parseFinding`. It rejects a level or an ID that disagrees with the rest of the finding.
- Every finding carries its ID as `partialFingerprints["melian/v1"]`, and `parseFinding` rejects a fingerprint that differs. GitHub code scanning matches alerts across uploads by partial fingerprints; without one it falls back to its own hash of the line, so a line shift closes one alert and opens another. Bump the key's version only with a change that migrates stored IDs.
- `createFindingsLog` lists each rule once in `tool.driver.rules`, sorted by ID, and gives each result the `ruleIndex` of its rule. GitHub reads rule metadata from there. `ruleIndex` belongs to a log, not a finding, so a stored finding has none and `parseFinding` rejects one.
- A region may not end before it starts: an `endLine` before `startLine`, or on one line an `endColumn` before `startColumn`, throws `FindingError` `invalidRegion`.
- Never store `undefined` in a finding. JSON drops it, so a round trip would change the value. `parseFinding`, and so `createFinding`, returns a copy with every `undefined`-valued key removed at any depth, so a nested `trigger.snippet: undefined` neither fails as a `TypeError` in storage nor makes the stored copy differ from the value in hand.
- `trigger` names the hunk that caused the finding by its `file` and `index`, as a `Hunk` names itself, rather than copying its line ranges. It is optional: a pre-existing finding has no triggering hunk. Its optional `snippet` is the changed code as the producer saw it; the pipeline reopens a dismissed finding when that code's `normaliseSnippet` changes.

### Paths and URIs

SARIF's `artifactLocation.uri` is a URI reference, not a path. Problem: git allows almost any byte in a file name, and `docs/release notes.md` or `src/100%.ts` copied into `uri` is not a valid URI, so a strict SARIF consumer rejects the whole log, and a `#` or `?` silently truncates the path. Solution: `createFinding` percent-encodes each path segment with `encodeURIComponent` and joins the segments with `/`, so `src/café/why?.ts` becomes `src/caf%C3%A9/why%3F.ts`. To decode, split the URI on `/` and apply `decodeURIComponent` to each segment. The raw repository-relative path stays in `properties.path` for consumers that want it, and is what `findingId` hashes, so encoding never changes an ID. `parseFinding` rejects a URI that does not encode `properties.path`. A path that is not UTF-8 arrives from the changeset already percent-encoded, with `ChangedFile.percentEncoded` set; `properties.path` keeps that form, so its `%` is encoded again as `%25` in the URI, and decoding the URI gives back the changeset's path.

A path is canonical: repository-relative, posix, with no empty or `.` segments. Problem: IDs, the findings document, and `classifyCause` compare paths as strings, so `./src/run.ts` and `src/run.ts` were two files with two IDs, and a finding at `./src/run.ts` never matched the changeset's `src/run.ts`. Solution: `createFinding` canonicalises the location's and the trigger's file, so `./src//run.ts` becomes `src/run.ts`, and `classifyCause` canonicalises before comparing. Both throw `FindingError` `invalidPath` for an empty or absolute path, one with a `..` segment, or one with a backslash, which is a Windows separator more often than a file name character. `parseFinding` refuses a stored path that is not already canonical.

### What a lens reports

`reportFindingInputSchema` is the lens-facing schema for step 5's `report_finding` tool, and holds exactly `file`, `line`, an optional `endLine`, `rule`, `severity`, `explanation` (`what`, `why`, `fix`), and an optional `evidence`. Every object in it rejects other keys. `FindingInput` stays the internal type that `createFinding` takes.

Problem: a finding's ID hashes its rule and snippet, so if the model supplies them, identity depends on its wording. Example: one run reports `eval(input)` under `no-eval`, the next copies the snippet as `eval( input );` under `unsafe-eval`, and the dismissed finding returns as new. A lens that also chose `resolution`, `cause`, or `status` could unblock its own findings. Solution: the lens supplies only what needs judgement, and Melian derives the rest.

- The snippet is the head revision's text at the reported lines, read through the revision source with `git show`, never taken from the model. `snippetOccurrence` on that file then gives the occurrence.
- `rule` must be one of the rules the lens declares in its front matter's `rules` list, which step 5 adds; the hook rejects any other.
- `source` is the lens's identity and version.
- `cause` is `classifyCause` of the location, made `affected` only by `evidence`, the changed code that provably breaks the location.
- `resolution` comes from configuration, and `status` from the findings document.

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

Location never proves `affected`. Problem: an earlier heuristic called anything in a changed file but outside its hunks `affected`, and `affected` can block. Example: a pull request fixes a typo on line 3 of `src/db.ts`, and a lens notices a SQL injection on line 80 that predates it. The heuristic made the old injection a blocker on an unrelated typo fix. Solution: `affected` needs evidence. `createFinding` makes a finding `affected` only through `cause: { evidence }`, where `evidence` names the changed code that provably breaks the location, such as "`src/api.ts:3` renames `id` to `userId`, which this call still passes positionally". It stores the citation in `properties.evidence`, and `parseFinding` throws `missingEvidence` for an `affected` finding without it and `invalidFinding` for evidence on any other cause. No heuristic produces evidence.

The cost is the other direction: a renamed parameter that breaks a caller is `pre-existing` until the lens cites the rename. Missing breakage is recoverable; blocking on an old defect teaches authors to ignore Melian. The design classifies cause through the decision model later, which may promote a finding with evidence but never without.

### Rendering

`renderFindingsJson` writes the SARIF log; `renderFindingsTerminal` writes plain text grouped by file in path order, and within a file by severity, then line, then ID. The terminal output carries no escape codes unless `color` is set, so a pipe or a log file receives plain text. Hosts decide whether to colour; core never reads `isTTY` or `NO_COLOR`.

Everything the renderer prints is untrusted. A lens writes finding text after reading the change under review, which anyone opening a pull request controls, and that author also chooses the file paths. Example: a file named `src/run.ts` followed by ESC `[2J` clears the reviewer's screen, a newline in a path or rule ID forges a second header, and a right-to-left override makes `gnp.ts` read as `ts.png`. The terminal renderer therefore prints every control character, C1 control, line or paragraph separator, and bidi control in every string, paths and rule IDs included, as a visible `\uXXXX`, with colour on or off. Prose keeps its newlines as indented continuation lines, so a multi-line explanation stays inside its block; a newline anywhere else is escaped. Any new renderer for a terminal does the same.

## Checks and tiers

`checksOfTier(config, tier)` lists a tier's checks in order without repeats. A name that is a tier expands to that tier's checks, and `static` expands to `static.biome` and `static.tsc`. An unknown tier is `CheckError` `unknownTier`, and a tier that includes itself is `tierCycle`. `deterministicChecks` names the checks the pipeline runs as tasks: `guardrails`, `static.biome`, and `static.tsc`. A check that cannot run throws `CheckError` with a code; it never returns an empty result.

## Guardrails

`evaluateGuardrails({ repoRoot, revision, source })` runs four deterministic policies in the Melian process. It never runs the repository's code: it reads the changeset, each path's layered `melian.yaml` from `source`, and, for forbidden-patterns, the changed files at head through git's object store. Each guardrail reports under `guardrail/<name>` at the severity its configuration sets, with the resolution the path's configuration gives that severity, and every finding is `introduced`, because a guardrail judges the change itself.

| Guardrail | Fires when | Default severity | Where the finding sits |
|---|---|---|---|
| `forbidden-paths` | a touched path, on either side of a rename, matches a rule's `paths` | `P1` | the path, line 1 |
| `required-files` | a touched path matches a rule's `when`, and no touched path matches one of its `require` | `P2` | the first such path, line 1, once per rule |
| `forbidden-patterns` | a line the change adds, in a file matching the rule's `paths` or any file when `paths` is absent, matches its `pattern` | `P2` | the added line, with its hunk as the trigger |
| `policy-change-review` | the revision changes one of `revision.policyFiles`, or a touched path matches the path's `files` | `P2` | the policy file, line 1 |

Policy includes the static tools' configuration. Problem: the static tools run on the head with the head's own configuration, so the head decides how its own results are judged. Example: a head adds `"noCheck": true` to `tsconfig.json` and tsc reports nothing. Solution: `revision.policyFiles` lists, besides `melian.yaml` and the standards files, every file named `biome.json`, `biome.jsonc`, `tsconfig*.json`, `package.json`, `.eslintrc*`, or `eslint.config.*`, at any depth, and policy-change-review reports each one changed. `policy-change-review.files` adds globs to that list, anchored to their file like any guardrail glob; layering replaces a farther file's list, never the built-in names.

Each path is judged by its own configuration, so a rule in `services/payments/melian.yaml` covers only that service. That configuration is the configuration of the directory holding the path, loaded as a directory whatever the path itself is. Problem: the lookup cached by directory but loaded the changed path, and a path that is a directory in the source includes its own `melian.yaml`. Example: a head replaces directory `legacy/`, whose `melian.yaml` disables forbidden-paths, with a file named `legacy`; the root's lookup then inherited `legacy/melian.yaml`, and `server.pem` at the root went unreported. Solution: the changed path's kind never enters the lookup. Several rules of one guardrail that fire on one path or one line give one finding, whose message joins theirs: they would share a finding ID, and the second would replace the first. Findings without code to hash take a discriminator: `path`, the rule name, `policy`, or for a blank or unreadable line, `line <n>`.

Problem: forbidden-patterns runs a pattern from configuration over lines the head's author wrote, and JavaScript's `RegExp` backtracks. Example: `.*foo.*bar` over a line of 20,000 `foo`s takes cubic time, and a pull request chooses the line. Solution: `src/pattern.ts` compiles a pattern to a Thompson NFA and runs every thread in step, so a line costs at most its length times the program size. It supports literals, `.`, classes, `\d \w \s` and their negations, `\b \B`, `^ $`, groups, alternation, and greedy or lazy quantifiers, and it refuses backreferences and lookaround, which no linear-time engine runs. It matches what `RegExp` without flags matches: `.` excludes `\n`, `\r`, U+2028, and U+2029, and `\s` includes them. A differential fuzz against `RegExp` over two million random patterns found only `.` matching line terminators, since fixed. forbidden-patterns strips one trailing `\r` from a line before matching, so `TODO$` matches in a CRLF file. `loadConfig` compiles every pattern when it reads the file, so a refused pattern is a `ConfigError` `invalidValue` naming the file and key rather than a failed review. Repetition counts stop at 100 and programs at 2,000 steps. Globs compile to the same engine, so a path cannot make a glob backtrack either: `*` and `?` stay within a segment, `**` crosses segments, and `**/` matches zero or more whole directories. Braces and character classes are not implemented, and the engine would read `*.{ts,js}` literally and match nothing, so a glob holding `{`, `}`, `[`, or `]` is a `ConfigError` `invalidValue` naming the file and key until brace expansion exists.

What forbidden-patterns cannot read, it says. A line over 10,000 characters is not scanned, and a file whose name is not UTF-8 is skipped; each adds a sentence to the report's `notes`. A file over 4 MiB at head is still scanned, but its findings are identified by line number, since its text cannot be read whole to count occurrences.

A file git calls binary has no hunks, and one NUL byte is enough to make git call it that. Problem: forbidden-patterns read only hunks, so a head could add a NUL to any file and nothing in it was scanned. Solution: a binary file at head that is UTF-8 and within 4 MiB is scanned line by line, skipping lines its base version already had, and its findings carry no trigger. Any other binary file adds a note naming it and why.

## Static analysis

Static tools report through SARIF. A runner, which lives in the pipeline because it executes repository code, produces one SARIF log per tool per revision; core turns the base and head logs into findings.

- `normaliseBiomeSarif` reads Biome's own SARIF reporter output. Biome writes absolute paths as URIs and no tool version, so the normaliser makes paths relative to the worktree it ran in, drops results outside it or under a `node_modules` directory, and records the version the runner read from `biome --version` as `tool.driver.version`.
- `parseTscDiagnostics` reads `tsc --noEmit --pretty false`: `file(line,col): error TS1234: message`, with indented lines continuing the message. A diagnostic without a file, such as an unreadable `tsconfig.json`, sits at the project file's line 1. Problem: the head writes the code whose types appear in messages, and a greedy match took the last `(n,n): error TSn:` on the line. Example: `src/a.ts(1,14): error TS2322: Type '"(9,9): error TS6133: x"' is not assignable` became rule `TS6133` in a file that does not exist, and a forged rule can hit a severity override or a path the parser drops. Solution: the file is the shortest prefix ending where a location could that names a file in the revision's tree, which the caller's `exists` answers; the runner lists the worktree with `git ls-files`.

Severity, by default:

| Tool | Result | Rule ID | Severity |
|---|---|---|---|
| Biome | `error` | `biome/<group>/<rule>`, from Biome's `lint/<group>/<rule>` | `P2` |
| Biome | `warning` | as above | `P3` |
| Biome | `note` (Biome's info) | as above | `nit` |
| tsc | error | `tsc/TS<code>` | `P1` |

`static.<tool>.severity` overrides one rule, keyed by its Melian rule ID.

`staticFindings` matches results across the two runs by finding identity, never by line. A result's snippet is the full text of its lines at that revision, read through git's object store, and its occurrence is counted in that revision's file, so a result moved by an edit above it keeps its ID. A renamed file's base results are identified under its head path, through `revision.files`; otherwise a pure rename would make every old result `introduced` and blocking. A result at head whose ID is absent at base is `introduced`; one present at both is `pre-existing` and never blocks; one only at base is resolved and not reported. Two results of one rule on the same lines share an ID, so they are one finding whose message counts the rest. A result on a blank line, or in a file too large to read, is identified by its message instead.

## Tests

- Run the package's tests with `npm test --workspace @melian-agent/core`, or one file with `npx vitest --run packages/core/test/changeset.test.ts` from the repository root.
- Build real repositories in a temporary directory in `beforeEach` with `test/fixtures/repo.ts`, and delete them in `afterEach`. Never mock git.
- Isolate git from the developer's configuration. `isolatedGitEnv` points `GIT_CONFIG_GLOBAL` at `/dev/null` and sets an author; without it, a developer who signs commits sees every fixture commit fail. Stub the same variables into `process.env` while code under test runs git.
- Take temporary directories through `temporaryDirectory()`, which resolves symlinks. On macOS the system temporary directory is a symlink, and git reports the resolved path, so a comparison with the unresolved one fails.
- Assert exact hunk ranges against a diff small enough to check by eye.
- Golden files live in `test/golden/`, compared with Vitest's `toMatchFileSnapshot`. A mismatch fails the gate. After a deliberate change, regenerate with `npx vitest --run -u packages/core/test/render.test.ts` and read the diff before committing. They use `.sarif` and `.txt` extensions, which Biome does not format.
- Run every loader test against both sources with `describe.each(sourceKinds)`. `sourceFor(root, kind)` commits the working tree for a revision, so one body checks that the two agree. Test what only a revision guarantees, such as ignoring the checked-out branch, in a block of its own.
- Await a rejection with `rejection(promise, ErrorClass)`, which fails unless the promise rejects with that class and returns the error typed.
