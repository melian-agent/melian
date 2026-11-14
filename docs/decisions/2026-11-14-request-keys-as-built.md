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

The exclusions are exactly the four rule 5 names, and core's `requestExclusions` is the only place they are written: `nonce`, `language`, `bestEffort` and `chosenBy`. A producer passes anything it leaves out under one of those names, and `KeyedRequest.of` refuses any other name. A test per producer changes each request field in turn and sees the key change, and changes each exclusion and sees it stay.

The four producers this build keys:

- **Triage**, producer `triage`, is a record kind. Its request holds the decider's name and version, the question set, the questions, the input-cut flag, and the state rendered with a fixed nonce. The real request, with its nonce, is unkeyed.
- **A check run**, producer `check`, is one request per tier run. It holds the configuration less its display keys (`output` and `publish.emoji`), the policy source less the preference file's path, Melian's tool pins, each analyser's version and where it came from, the checkout's install, Stryker's version, installation and where it came from, with the head's trust and the cold flag when mutation is on, the version of Melian's own code for each deterministic check, and the host facts: platform, architecture, Node's version and whether the filesystem folds case. Core's `hostFacts` asks the filesystem under the system's temporary directory, where each run's worktree sits, once per directory. The facts are the Melian process's, which are the tools' own while the local environment is the only one. An environment that runs tools elsewhere, such as a container, must supply its own host facts to the request. A working-tree source also keys the text of every `melian.yaml` the guardrails would read for the touched paths, nested ones included, through core's `configLookup`. A file past `maxConfigBytes`, 64 KiB, the files together past 1 MiB, or a file that cannot be read keys `unread` instead. `checkReusable` then marks the run not reusable, and `runChecks`, the one place that looks a run up by its key, starts a new run rather than attach to it. The guardrails still report the failure. A random value in the key would have done the same, but rule 6 of the identity guideline forbids one. A revision source needs none of this: its commit names every file. The install is a digest of each package manager's lockfile and of npm's record of what `node_modules` holds, `node_modules/.package-lock.json`, which an `npm install` of one package changes without touching `package-lock.json`. Biome and tsc resolve from that install, so a changed install runs them again. `installDigests`, the mutation check's reader, writes it, and a record the checkout lacks reads `unavailable`, so a checkout without one never shares a key with one that has it. The mutation check's installation identity gains the same record. The run's identity is its base, head, tier and the first 16 hex digits of this key.
- **A verification**, producer `verification`, holds the review state less its nonce and its checkout's path, every candidate by `candidateIdentity`, which also keys a wave's outcome under producer `verification.candidate`, and the verifier's fixed text: its read tools, the report tool's name, description and parameters, the injection policy under a fixed nonce, and the line templates. The `reused` wave outcomes stay out: they are other runs' answers. So does the root conversation's ID, which storage mints. A wave's outcome stands under `waveVersion`, a key of the verifier's version and its fixed text under producer `verification.wave`, and a test ties that pair to every input of the final key that neither a candidate's key nor the revision covers.
- **A walkthrough**, producer `walkthrough`, holds the revision, the prompt under a fixed nonce, the model, the thinking level, the paths, the instructions and the record tool's name, description and parameters. A task stored before the key attaches by its route alone, as it did.

No request holds an absolute path or an ID storage minted, by rule 6 of [the identity guideline](../guidelines/identity.md#rules). A producer leaves each out by destructuring it away beside the hash, with a comment saying why, as it leaves out `reused`; none needs a fifth unkeyed name. The preference file's content still reaches the check run's key through the configuration it merges into. Codex's review of [pull request #436](https://github.com/melian-agent/melian/pull/436) found the verification's root and checkout in its key, and the check run's two paths are the same class.

## Reuse compares request keys

Reuse is decided by comparing request keys and nothing else. A narrower comparison misses whatever its list leaves out: Codex's second and third reviews of [pull request #436](https://github.com/melian-agent/melian/pull/436) each found one, the verifier's fixed text in a wave and the install in a check run. Three places still compare something narrower, each with the issue that closes it:

- A wave stands by its wave version, not by the final verification's key, until [issue #441](https://github.com/melian-agent/melian/issues/441).
- The lens task attaches by `instructionFingerprint` and `selectionOf`, until [issue #432](https://github.com/melian-agent/melian/issues/432).
- A check's own code reaches its key only through the hand-raised `checkVersions`, until [issue #437](https://github.com/melian-agent/melian/issues/437).

The lens run is not keyed by this build. Its request, enclosing functions included, and lens reuse per run are [issue #432](https://github.com/melian-agent/melian/issues/432). Until it lands, the lens task attaches through `instructionFingerprint` and `selectionOf`, and rule 8's import of lens records waits for it.

## What this gives up

A check's version, in `checkVersions` in `packages/pipeline/src/check-request.ts`, is raised by hand whenever the check's logic changes what it can find or how it reports. A change nobody marks reuses the older build's results, and once records are shared between machines, a clean result can pass from an older build to a newer one. A test that hashes each check's code and fails when it changes without its number is the likely fix, in [issue #437](https://github.com/melian-agent/melian/issues/437). The keys before this build held no version of Melian's check code at all.

The verification and walkthrough keys differ from the ones stored before. Each stored revision verifies once more, and asks its walkthrough once more, the first time it is reviewed after this lands. Check runs rerun once for the same reason, and so does each stored wave, at one verifier call. A mutation partition starts cold once, since its installation identity now holds npm's record of the install. That costs the verifier's and the walkthrough's model calls, never a lens's, and the checks cost no tokens. So it costs less than a whole round, which cost $3.57 to $9.85 on recent pull requests. A new push reruns all of it anyway, so the cost falls only on a head reviewed before the upgrade and reviewed again after it, at most once for each open pull request. The lens rerun waits for [issue #432](https://github.com/melian-agent/melian/issues/432), which changes the lens key.

A working tree can change between keying and running. The key reads each `melian.yaml` before the run starts, and the guardrails read it again as they run, so an edit in that window is run under one text and recorded under the other. The root configuration has the same window today: `runChecks` hashes it before any check reads it. Every check reads code from a commit, so only the working tree's policy files have it. A review of a working tree is the maintainer's own, so the window is a known limit, not a trust gap.

Host facts enter a check's key, so a Linux runner's result never answers for a macOS checkout. Two hosts that differ only in Node's patch version also rerun each other's checks. Rule 5 accepts that cost.

The identity guideline's two claim-identity forms and two dismissal-identity forms stand. No third form was added; joining them is a stored-shape change of its own.
