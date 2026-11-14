# Request keys as built

Amends: [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md), rule 5's producers, request contents and exclusions
Amends: [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md), rule 8, for the lens run, until [issue #432](https://github.com/melian-agent/melian/issues/432)

The maintainer ruled on 2026-11-14, in the coordinator's session, that triage is a record kind keyed by its request, and that enclosing functions join a lens's request. [Issue #394](https://github.com/melian-agent/melian/issues/394) built the key function and four of its producers. This decision records what that build settled and what waits.

## The problem

Rule 5 lists what each request holds, but it was written before the code. Building it found four places where the list and the code part:

- Triage asks a model, and its answer decides which lenses run at what level. Rule 5 named no triage request, so a second host could not tell whether a recorded answer was to its own question.
- Rule 5 leaves a lens's enclosing functions out as best effort. The maintainer ruled that they decide what the lens reads, so they belong in its request.
- Rule 5 names a check's request as its name, base, head and policy hash. Checks run as one task per tier, and a run is what a host reuses.
- A verification task's input holds the outcomes of standing waves it reuses. Those are other runs' answers, not part of what this verifier is asked.

## The rule

Core's `KeyedRequest.of(producer, request, unkeyed)` builds every key. The key is the SHA-256 of the canonical bytes of `{ producer, request }`, so two producers asked the same thing get two keys. `requestJson` makes a request canonical first: it drops a field left undefined at any depth, keeps `null`, and writes a number that is not a safe integer as its decimal text.

The exclusions are exactly the four rule 5 names, and core's `requestExclusions` is the only place they are written: `nonce`, `language`, `bestEffort` and `chosenBy`. A producer passes anything it leaves out under one of those names, and `KeyedRequest.of` refuses any other name. A test per producer changes each request field in turn and sees the key change, and changes each exclusion and sees it stay. Leaving the nonce out has one consequence. A key renders the change's text under a fixed nonce, 24 zeros, and `quoteUntrusted` replaces any copy of the nonce in that text with `[nonce]`. So text holding the zeros and text holding `[nonce]` in the same place render alike, and two changes that differ only there share a key. A decider shown either learns nothing from the difference. Under a review's own nonce, neither text can close or move its boundary: a probe of `quoteUntrusted` for [pull request #436](https://github.com/melian-agent/melian/pull/436) found exactly one closing tag in every case, even for a text that closes the boundary under the fixed nonce.

The four producers this build keys:

- **Triage**, producer `triage`, is a record kind. Its request holds the decider's name and version, the question set, the questions, the input-cut flag, and the state rendered with a fixed nonce. The real request, with its nonce, is unkeyed.
- **A check run**, producer `check`, is one request per tier run. It holds the configuration less its display keys (`output` and `publish.emoji`), the policy source less the preference file's path, Melian's tool pins, each analyser's version and where it came from, the checkout's install, Stryker's version, installation and where it came from, with the head's trust and the cold flag when mutation is on, the version of Melian's own code for each deterministic check, and the host facts: platform, architecture, Node's version and whether the filesystem folds case. Core's `hostFacts` asks the filesystem under the system's temporary directory, where each run's worktree sits, once per directory. The facts are the Melian process's, which are the tools' own while the local environment is the only one. An environment that runs tools elsewhere, such as a container, must supply its own host facts to the request. A working-tree source also keys the text of every `melian.yaml` the guardrails would read for the touched paths, nested ones included, through core's `configLookup`. A file past `maxConfigBytes`, 64 KiB, the files together past 1 MiB, or a file that cannot be read keys `unread` instead. `checkReusable` then marks the run not reusable, and `runChecks`, the one place that looks a run up by its key, starts a new run rather than attach to it. The guardrails still report the failure. A random value in the key would have done the same, but rule 6 of the identity guideline forbids one. A revision source needs none of this: its commit names every file. The install is a digest of each package manager's lockfile and of the records it writes of what `node_modules` holds, which an install of one package changes without touching the lockfile; the next section lists them. Biome and tsc resolve from that install, so a changed install runs them again. `installDigests`, the mutation check's reader, writes it. A file the checkout lacks reads `unavailable`, so a checkout without one never shares a key with one that has it. A file it cannot read reads `unreadable`. A lockfile none of whose manager's records is present leaves nothing to compare either, since a missing record would read as an unchanged install, and so does a `node_modules` with no manager's record and no Bun lockfile beside it. Each leaves the install unidentified, and `checkReusable` marks the run not reusable, as it does an unread policy. Whether the install is identified is keyed beside its digests. Whether `node_modules` exists decides it too, and no digest records that, so a run made beside an unrecorded `node_modules` would otherwise share a key with one made after it was removed, and answer for it. The mutation check's installation identity gains the same records. The run's identity is its base, head, tier and the first 16 hex digits of this key.
- **A verification**, producer `verification`, holds the review state less its nonce and its checkout's path, every candidate by `candidateIdentity`, which also keys a wave's outcome under producer `verification.candidate`, and the verifier's fixed text: its read tools, the report tool's name, description and parameters, the injection policy under a fixed nonce, and its prompt and first input. The task's own functions render those with placeholders for what varies, so every heading and prefix the verifier is shown reaches the key. The `reused` wave outcomes stay out: they are other runs' answers. So does the root conversation's ID, which storage mints. A wave's outcome stands under `waveVersion`, a key of the verifier's version and its fixed text under producer `verification.wave`, and a test ties that pair to every input of the final key that neither a candidate's key nor the revision covers.
- **A walkthrough**, producer `walkthrough`, holds the revision, the prompt under a fixed nonce, the model, the thinking level, the paths, the instructions and the record tool's name, description and parameters. A task stored before the key attaches by its route alone, as it did.

No request holds an absolute path or an ID storage minted, by rule 6 of [the identity guideline](../guidelines/identity.md#rules). A producer leaves each out by destructuring it away beside the hash, with a comment saying why, as it leaves out `reused`; none needs a fifth unkeyed name. The preference file's content still reaches the check run's key through the configuration it merges into. Codex's review of [pull request #436](https://github.com/melian-agent/melian/pull/436) found the verification's root and checkout in its key, and the check run's two paths are the same class.

## What a check run's key holds and leaves out

A check run's results depend on what each check reads and on the code that reads it. The key holds each of these:

- The base, head and tier, in the run's identity. Every check reads code and committed policy from these commits.
- The configuration less its display keys, and the policy source less the preference file's path.
- A working-tree source's `melian.yaml` text, or `unread`.
- Melian's tool pins, which fix Enola's binary by its digest.
- Biome's and tsc's versions, and whether each came from the checkout or from Melian.
- The install, as each package manager records it, and whether those records identify it. A real install by each manager established its records, run in a cloud session on 2026-11-14. In each, the record changed when the installed version of one package changed, and stayed the same on a repeat install. pnpm and Yarn 4 changed it with the lockfile left alone:
  - npm 11 writes `node_modules/.package-lock.json` beside `package-lock.json`.
  - pnpm 9.15.0 writes `node_modules/.pnpm/lock.yaml` beside `pnpm-lock.yaml`.
  - Yarn 1.22.22 writes `node_modules/.yarn-integrity` beside `yarn.lock`.
  - Yarn 4.5.3 writes `.yarn/install-state.gz` with either linker, and `node_modules/.yarn-state.yml` with `node_modules`, or `.pnp.cjs` with Plug'n'Play. Under Plug'n'Play there is no `node_modules` for tsc to resolve from, so its records stand for the install that would be linked.
- With mutation on, Stryker's version, installation identity and source, the head's trust and the cold flag.
- The version of Melian's own code for each check, raised by hand until [issue #437](https://github.com/melian-agent/melian/issues/437).
- The host facts: platform, architecture, Node's version and whether the filesystem folds case.

The key leaves these out, each for its reason:

- `output` and `publish.emoji`, which change how a review reads and never what a check finds.
- The preference file's path and Stryker's install path, which name the host. What the preference file says reaches the key through the configuration.
- Bun's install. Bun 1.2.23 wrote no record of what it installed, so its lockfiles alone are keyed: a `bun install` that changes `node_modules` and leaves `bun.lock` alone reuses the earlier run.
- A hand edit or `npm link` inside an install a manager recorded, and nothing else. The records are the managers' own account of the install, and Melian does not walk `node_modules` to second-guess them. A `node_modules` no manager recorded is not this case: it leaves the install unidentified, and the run is not reused.
- The four variables a tool runs with, `PATH`, `HOME`, `TMPDIR` and `LANG`, which name the host. Melian stores no tool's text, so `LANG` cannot change a finding.
- An install that changes while a check runs. The key reads the install files before the run, and tsc reads `node_modules` a little later, so an `npm install` in that window stores a run made under the new install under the old install's key. It needs someone installing packages mid-review on their own machine, as the working-tree policy window below does, and reading the files again after the run would narrow the window without closing it.
- A working tree's `melian.yaml` edited while a check runs, the policy window below.
- How Biome's, tsc's and Stryker's versions are read: from each package's `package.json` in the install the tool runs from, never by running the tool. npm's record of the install names that manifest, so a binary that disagrees with its own manifest is a hand edit inside a recorded install, the one exclusion above, and an unrecorded install is never reused.
- Host facts for an environment that runs tools somewhere other than the Melian process, such as a container. No such environment exists yet; one that does must supply its own facts to the request, as the first section says.
- The mutation check's partition reuse. A run handed an earlier report is provisional and leaves the review not reviewed, so a stale partition costs a rerun and never passes a review.

A review that names an input on neither list goes to the coordinator before any fix.

## Reuse compares request keys

Reuse is decided by comparing request keys and nothing else. A narrower comparison misses whatever its list leaves out: Codex's second and third reviews of [pull request #436](https://github.com/melian-agent/melian/pull/436) each found one, the verifier's fixed text in a wave and the install in a check run. Three places still compare something narrower, each with the issue that closes it:

- A wave stands by its wave version, not by the final verification's key, until [issue #441](https://github.com/melian-agent/melian/issues/441).
- The lens task attaches by `instructionFingerprint` and `selectionOf`, until [issue #432](https://github.com/melian-agent/melian/issues/432).
- A check's own code reaches its key only through the hand-raised `checkVersions`, until [issue #437](https://github.com/melian-agent/melian/issues/437).

The lens run is not keyed by this build. Its request, enclosing functions included, and lens reuse per run are [issue #432](https://github.com/melian-agent/melian/issues/432). Until it lands, the lens task attaches through `instructionFingerprint` and `selectionOf`, and rule 8's import of lens records waits for it.

## What this gives up

A check's version, in `checkVersions` in `packages/pipeline/src/check-request.ts`, is raised by hand whenever the check's logic changes what it can find or how it reports. A change nobody marks reuses the older build's results, and once records are shared between machines, a clean result can pass from an older build to a newer one. A test that hashes each check's code and fails when it changes without its number is the likely fix, in [issue #437](https://github.com/melian-agent/melian/issues/437). The keys before this build held no version of Melian's check code at all.

The verification and walkthrough keys differ from the ones stored before. Each stored revision verifies once more, and asks its walkthrough once more, the first time it is reviewed after this lands. Check runs rerun once for the same reason, and so does each stored wave, at one verifier call. A mutation partition starts cold once, since its installation identity now holds each manager's records of the install. A checkout with a lockfile and none of its manager's records, one never installed or installed by another manager, or a `node_modules` no manager recorded, never reuses a check run, and reruns Biome and tsc on every review. The triage key differs from the one stored before as well, so each stored revision asks triage once more. Where the new answer gives every lens the level it had, the lens tasks attach as before. Where it gives a lens another level, that lens runs again at the new one, a lens's tokens. Otherwise this costs the verifier's and the walkthrough's model calls, never a lens's, and the checks cost no tokens. So it costs less than a whole round, which cost $3.57 to $9.85 on recent pull requests. A new push reruns all of it anyway, so the cost falls only on a head reviewed before the upgrade and reviewed again after it, at most once for each open pull request. The lens rerun waits for [issue #432](https://github.com/melian-agent/melian/issues/432), which changes the lens key.

A working tree can change between keying and running. The key reads each `melian.yaml` before the run starts, and the guardrails read it again as they run, so an edit in that window is run under one text and recorded under the other. The root configuration has the same window today: `runChecks` hashes it before any check reads it. Every check reads code from a commit, so only the working tree's policy files have it. A review of a working tree is the maintainer's own, so the window is a known limit, not a trust gap.

Host facts enter a check's key, so a Linux runner's result never answers for a macOS checkout. Two hosts that differ only in Node's patch version also rerun each other's checks. Rule 5 accepts that cost.

The identity guideline's two claim-identity forms and two dismissal-identity forms stand. No third form was added; joining them is a stored-shape change of its own.
