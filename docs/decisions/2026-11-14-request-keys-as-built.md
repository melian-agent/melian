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
- **A check run**, producer `check`, is one request per tier run. It holds the configuration less its display keys (`output` and `publish.emoji`), the policy source less the preference file's path, Melian's tool pins, each analyser's version and where it came from, Stryker's version, installation and where it came from, with the head's trust and the cold flag when mutation is on, the version of Melian's own code for each deterministic check, and the host facts: platform, architecture, Node's version and whether the filesystem folds case. Core's `hostFacts` asks the filesystem under the system's temporary directory, where each run's worktree sits, once per directory. The facts are the Melian process's, which are the tools' own while the local environment is the only one. An environment that runs tools elsewhere, such as a container, must supply its own host facts to the request. The run's identity is its base, head, tier and the first 16 hex digits of this key.
- **A verification**, producer `verification`, holds the review state less its nonce and its checkout's path, every candidate by `candidateIdentity`, which also keys a wave's outcome under producer `verification.candidate`, and the verifier's fixed text: its read tools, the report tool's name, description and parameters, the injection policy under a fixed nonce, and the line templates. The `reused` wave outcomes stay out: they are other runs' answers. So does the root conversation's ID, which storage mints.
- **A walkthrough**, producer `walkthrough`, holds the revision, the prompt under a fixed nonce, the model, the thinking level, the paths, the instructions and the record tool's name, description and parameters. A task stored before the key attaches by its route alone, as it did.

No request holds an absolute path or an ID storage minted, by rule 6 of [the identity guideline](../guidelines/identity.md#rules). A producer leaves each out by destructuring it away beside the hash, with a comment saying why, as it leaves out `reused`; none needs a fifth unkeyed name. The preference file's content still reaches the check run's key through the configuration it merges into. Codex's review of [pull request #436](https://github.com/melian-agent/melian/pull/436) found the verification's root and checkout in its key, and the check run's two paths are the same class.

The lens run is not keyed by this build. Its request, enclosing functions included, and lens reuse per run are [issue #432](https://github.com/melian-agent/melian/issues/432). Until it lands, the lens task attaches through `instructionFingerprint` and `selectionOf`, and rule 8's import of lens records waits for it.

## What this gives up

A check's version, in `checkVersions` in `packages/pipeline/src/check-request.ts`, is raised by hand whenever the check's logic changes what it can find or how it reports. A change nobody marks reuses the older build's results, and once records are shared between machines, a clean result can pass from an older build to a newer one. A test that hashes each check's code and fails when it changes without its number is the likely fix, in [issue #437](https://github.com/melian-agent/melian/issues/437). The keys before this build held no version of Melian's check code at all.

The verification and walkthrough keys differ from the ones stored before. Each stored revision verifies once more, and asks its walkthrough once more, the first time it is reviewed after this lands. Check runs rerun once for the same reason. That costs the verifier's and the walkthrough's model calls, never a lens's, and the checks cost no tokens. So it costs less than a whole round, which cost $3.57 to $9.85 on recent pull requests. A new push reruns all of it anyway, so the cost falls only on a head reviewed before the upgrade and reviewed again after it, at most once for each open pull request. The lens rerun waits for [issue #432](https://github.com/melian-agent/melian/issues/432), which changes the lens key.

Host facts enter a check's key, so a Linux runner's result never answers for a macOS checkout. Two hosts that differ only in Node's patch version also rerun each other's checks. Rule 5 accepts that cost.

The identity guideline's two claim-identity forms and two dismissal-identity forms stand. No third form was added; joining them is a stored-shape change of its own.
