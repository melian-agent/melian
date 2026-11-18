# Stored results against the build model

An audit, for [issue #569](https://github.com/melian-agent/melian/issues/569), of every place Melian stores a result, measured against the model [issue #568](https://github.com/melian-agent/melian/issues/568) proposes. It read the code at commit `2e3bec758adea5522c8bba63226410f01ad28d17`, `main` on 2026-11-18, just after [pull request #552](https://github.com/melian-agent/melian/pull/552) merged. It ran nothing: no tests, no review, no build. Every claim names a file and line that was read. Where the reading stopped short, the row says "not verified" and why.

## The model, and what this audit asks of each row

Issue #568 proposes that a review work like a cached build:

1. Every step has a key: a hash of everything its result depends on.
2. A result is stored under the key of the request that produced it, and never overwritten.
3. Reuse is a lookup by key, never a judgement about stored state.
4. A review is a walk: look each step up, reuse a hit, run a miss.
5. A verdict is computed from the results and the base's policy. It reads results; it is not a place results are written.

Each row below is one stored thing: a Pi Durable document (`defineDoc`), a task whose input or output decides reuse (`defineTask`), a kind of shared record, or a cache on disk. Each row says what it is and where, what key it is stored under, who writes it and whether a write replaces an earlier value, who reads it to decide something, which kind it is, how it gives a wrong answer, and what guards it.

The five kinds, from issue #569:

- **Sound:** stored under its producer's key and never replaced.
- **Shared slot:** stored under something other than its producer's key, so another producer's write can replace it.
- **Judged reuse:** reused by a rule that inspects stored state, where a lookup by key belongs. The row names the rule.
- **Thin key:** a key known not to cover an input its result depends on. The row names the input and says whether the code marks it, as `install.identified` marks an install it could not identify.
- **Hand version:** a version number a person raises by hand, which decides reuse or migration.

A row can be more than one kind. One row, D9, fits none: its key is sound and its reader skips a check, so it is counted as a reader gap.

A wrong answer **fails open** when it lets something through: a pass, a dropped finding, a wrong dismissal, or text leaving the host that should stay. It **fails closed** when it costs a rerun or reads as not reviewed.

Paths: a bare file name such as `checks.ts` is in `packages/pipeline/src/`. A path that starts with a package's name, such as `core/src/record.ts`, is under `packages/`.

How the rows were found: every `defineDoc`, `defineDocFamily` and `defineTask` in `packages/*/src`, every record kind in `core/src/record.ts` and `core/src/record-payloads.ts`, every function named for reuse or standing (`runStands`, `checkReusable`, `attachable`, `copiesFrom`, `owned`), every `version:` on a definition, every hand-kept version constant, and every `createHash` call in the five packages. The identity guideline's table, [docs/guidelines/identity.md](../guidelines/identity.md), was the starting list.

Two notes on the head read. [Pull request #557](https://github.com/melian-agent/melian/pull/557) is open and not on it: the findings document here is version 11 and holds no `checkRuns` stamp. The relay ([issue #397](https://github.com/melian-agent/melian/issues/397)) and the gate ([issue #395](https://github.com/melian-agent/melian/issues/395)) are not built; the answers below say what exists in their place.

## The table

One line per row. The detail for each follows in [The rows in detail](#the-rows-in-detail).

| Row | Stored thing | Where | Kind | Wrong answer | Covered by |
| --- | --- | --- | --- | --- | --- |
| A1 | A static or guardrail check's sightings in the findings document | `findings.ts:481-509`, written at `checks.ts:474` | shared slot | **open**: a stale run empties a newer run's blocker, and the review passes | [#562](https://github.com/melian-agent/melian/issues/562); export only: [#528](https://github.com/melian-agent/melian/issues/528), [#557](https://github.com/melian-agent/melian/pull/557) |
| A2 | Check run attach: `ChecksDocument.tasks` and `identityKey` | `checks.ts:102-115`, `799-822` | sound; thin key (64-bit prefix, marked) | closed | none needed |
| A3 | The check request key, `checkRequest` | `check-request.ts:115-135` | thin key | **open**: a resumed or differently-run check is recorded under a key it did not run with | [#458](https://github.com/melian-agent/melian/issues/458), [#459](https://github.com/melian-agent/melian/issues/459), [#437](https://github.com/melian-agent/melian/issues/437); Bun install: none |
| A4 | `checkVersions`, the version of Melian's own check code | `check-request.ts:46-56` | hand version | **open**: changed check code reuses runs of the old code | [#437](https://github.com/melian-agent/melian/issues/437) |
| A5 | `fixedTextSince` and `writesFixedText` | `check-request.ts:79-98` | hand version | **open** on secrecy: tool text can leave the host | [#437](https://github.com/melian-agent/melian/issues/437); [#557](https://github.com/melian-agent/melian/pull/557) changes it |
| A6 | Mutation authority, `owners[revision]` | `checks.ts:98-99`, `364-368` | shared slot, by design | closed | none needed |
| A7 | A rerun's kept check records, `rerunOf` | `checks.ts:737-755` | judged reuse | **open**, through A1 | [#562](https://github.com/melian-agent/melian/issues/562) |
| A8 | Check task and document definition versions | `checks.ts:102-134`, `375-385`, `525-532` | hand version | closed | [#437](https://github.com/melian-agent/melian/issues/437) in part |
| A9 | `CheckSources` | `checks.ts:117-125` | sound | none | none needed |
| A10 | `MutationProcesses` | `checks.ts:127-134` | sound | none | none needed |
| A11 | Mutation cache partition | `mutation-cache.ts:59-76`, `180-189` | shared slot; judged reuse; thin key (marked `provisional`); hand version | closed | none needed |
| A12 | `mutationSelectionVersion` | `mutation-vitest.ts:84` | hand version | **open**: changed test selection reuses an old mutation run | [#437](https://github.com/melian-agent/melian/issues/437) |
| A13 | Enola graph cache, `GraphSnapshot.key` | `graph-cache.ts:34-127`, `core/src/graph.ts:60-65` | sound; hand version (schema) | **open** only to someone who can write the state directory | none found |
| A14 | Coverage cache producer index | `coverage-cache.ts:43-56` | shared slot; hand version | decides nothing found | none needed |
| A15 | Coverage artefact IDs | `core/src/coverage-artifacts.ts:161-162` | sound | none | none needed |
| A16 | Review coverage identity | `callers.ts:197-199` | sound | none | none needed |
| A17 | Tool cache directory | `tool-cache.ts:74` | sound | none | none needed |
| A18 | State directory hash | `tool-provisioning.ts:15-38` | sound | none | none needed |
| A19 | Static worktree lock reason | `static.ts:604-605` | sound | closed | none needed |
| A20 | Cache scratch names | `cache-scratch.ts:16-74` | sound | closed | none needed |
| A21 | `melian store prune` | `store-prune.ts:9-11`, `198-229` | sound (a reader) | closed | none needed |
| B1 | The lens task, `melian.lenses` | `review.ts:551-563` | sound; hand version | closed | none needed |
| B2 | The lens run key, `name@version@level` | `review.ts:2784` | sound in a task; thin key across tasks | none found | none needed |
| B3 | The lens request and selection | `lens-request.ts:96-141`, `review.ts:1684-1686` | thin key | **open**: a finished run is reused after an input it read changed | [#531](https://github.com/melian-agent/melian/issues/531), [#437](https://github.com/melian-agent/melian/issues/437), [#470](https://github.com/melian-agent/melian/issues/470); installs: ruled out of the key |
| B4 | The review index, `melian.reviews` | `review-index.ts:41-58` | shared slot; hand version | closed | none found |
| B5 | Attaching a review to an existing lens task | `review.ts:1772-1803` | judged reuse; thin key (callers, marked `bestEffort`) | weak: less context, by design | none found |
| B6 | Copying lens runs: `copiesFrom`, `lensCopies`, `runStands` | `review.ts:1295-1305`, `1712-1740`, `lens-reuse.ts:35-66` | judged reuse; thin key | **open**, through B3 | [#531](https://github.com/melian-agent/melian/issues/531), [#437](https://github.com/melian-agent/melian/issues/437) |
| B7 | A lens's sightings in the findings document | `lens-tools.ts:1641-1647`, `findings.ts:130-132` | shared slot, fenced | closed | none needed |
| B8 | `LensDocument` | `lens-tools.ts:223-230` | sound | none | none needed |
| B9 | `ProbingDocument` | `probing.ts:218-238` | sound | none | none needed |
| B10 | Probe reruns, `ProbeReruns` and its task | `probing.ts:751-771`, `review.ts:1521-1626` | shared slot; judged reuse; thin key | **open**: a stale clean rerun can let a finding be refuted | [#531](https://github.com/melian-agent/melian/issues/531) in part; installs: ruled out |
| B11 | The verification task and its verdicts | `verification.ts:114-426` | shared slot; judged reuse; thin key; hand version | **open**: changed answer-handling code reuses an old refutation | [#437](https://github.com/melian-agent/melian/issues/437) |
| B12 | The candidate key | `verification.ts:432-445` | sound | none | none needed |
| B13 | Verification waves and the wave version | `verification-waves.ts:13-106`, `verification.ts:604-726` | judged reuse, over keys; hand version | closed | none needed |
| B14 | `verifierVersion` | `verification-instructions.ts:58-73` | sound | none | none needed |
| B15 | The walkthrough | `summarize.ts:39-47`, `178-281`, `438-443` | shared slot; judged reuse; thin key | a stale display only | [#443](https://github.com/melian-agent/melian/issues/443) |
| B16 | Triage's decision, task and request | `decisions.ts:22-178`, `triage-request.ts:33-52`, `review.ts:2242-2335` | sound; thin key (code); hand version | **open** within the band policy allows | [#437](https://github.com/melian-agent/melian/issues/437) |
| B17 | The caller record, `callersFor` | `review.ts:1950-1980` | sound | none | none needed |
| B18 | The lens `version` | `core/src/lens.ts:356-362` | sound | none | none needed |
| B19 | `questionFingerprint` | `core/src/decider.ts:16-19` | thin key (marked optional) | not verified | none found |
| C3 | Verification verdicts in the findings document | `findings.ts:73`, `747-767`, `888-905`, `961-988` | shared slot | closed on this reading; not verified | none needed |
| C4 | The findings version counter | `findings.ts:84-89`, `647-652` | sound, on one host | none | none needed |
| C5 | A dismissal on a finding's lifecycle | `findings.ts:42-56`, `319-344`, `520-606` | judged reuse (`reopens`) | **open**: a dismissal made at P3 holds when the finding returns at P0 | none found |
| C6 | Inherited dismissals, `identityOf` | `findings.ts:818-830`, `1109-1147` | judged reuse (the verifier's "same") | **open** within the fence a decision accepted | [the decision](../decisions/2026-11-08-dismissal-carries-to-restatement.md) |
| C7 | The verdict slot, `melian.verdicts` | `adjudication.ts:104-180`, `309-322` | shared slot | closed | none needed |
| C8 | The adjudication task and its attach key | `review.ts:1991-2002`, `adjudication.ts:230-249` | shared slot; thin key; hand version | **open**: changed adjudication code reprints an old pass | none found |
| C9 | The resolution policy fingerprint | `configurations.ts:19`, `41-156` | sound; hand version | closed | [#525](https://github.com/melian-agent/melian/pull/525), merged |
| C10 | `Verdict.fingerprint` | `core/src/adjudication.ts:799-829` | sound | none | none needed |
| C11 | Carrying posted threads, the `reusable` map | `core/src/adjudication.ts:704-753` | judged reuse | a stale thread only | none found |
| C12 | Rounds and the round ID | `rounds.ts:49-164` | shared slot; thin key | closed for the verdict | none found |
| C13 | Pull-request round membership | `pull-request-rounds.ts:35-148` | sound | none | none needed |
| C14 | Comparisons and the external finding ID | `compare.ts:93-102`, `core/src/comparison.ts:238-244` | shared slot | evals only | none found |
| C15 | Publication record, `melian.published` | `publish.ts:228-241` | sound | none | none needed |
| C16 | The publisher document: secret and target | `publish.ts:279-287` | shared slot, by design | closed | none needed |
| C17 | Signed markers | `github/src/publication.ts:48-95` | sound; judged reuse (quiet advisories) | display only | none needed |
| C18 | The ledger comment and its stamp | `github/src/ledger.ts:120-148` | sound | none | none needed |
| C19 | The publish task | `publish.ts:568` | sound | none | none needed |
| C20 | Run details and telemetry documents | `telemetry.ts:45-53`, `token-usage.ts:10-29`, `task-timing.ts:4-12`, `spans.ts:11-20` | sound; shared slot (`melian.prepare`) | decides nothing | none needed |
| C21 | Changeset IDs and `Revision.key` | `core/src/changeset.ts:195-202`, `283-291`, `524-528` | sound | none | none needed |
| C22 | Document and task shape versions | `findings.ts:103` and the others listed in the row | hand version | depends on the field; not verified | none found |
| D1 | Record ID, `SharedRecord.id` | `core/src/record.ts:202-235` | sound | none | none needed |
| D2 | Record slot, `supersedes` and `replaces` | `core/src/record.ts:255-334` | sound | none | [#395](https://github.com/melian-agent/melian/issues/395) decides replacement |
| D3 | The request key, `KeyedRequest.of` | `core/src/request-key.ts:75-91` | sound, as a mechanism | none | none needed |
| D4 | Check record | `review-records.ts:163-170`, `review.ts:3143-3172` | shared slot; thin key; hand version | **open**: exports a `ran` record with no sightings after A1's sequence | [#562](https://github.com/melian-agent/melian/issues/562); [#557](https://github.com/melian-agent/melian/pull/557); [#459](https://github.com/melian-agent/melian/issues/459) |
| D5 | Lens record | `review-records.ts:176-195` | shared slot, fenced | closed | none needed |
| D6 | Verification record | `review-records.ts:198-218`, `review.ts:3706-3721` | shared slot; judged reuse (written last) | closed on this reading; not verified | none found |
| D7 | Walkthrough record | `review-records.ts:221-231`, `summarize.ts:161-177` | shared slot | decides nothing | [#443](https://github.com/melian-agent/melian/issues/443) |
| D8 | Account record and its key | `review-records.ts:279-325`, `392-397` | thin key | **open** only to a store writer: `checks` and `allowSkip` taken as given | [#395](https://github.com/melian-agent/melian/issues/395) |
| D9 | Round record and its reader | `review-records.ts:332-348`, `core/src/record.ts:460-475`, `recorded-round.ts:135-188` | reader gap | **open** only to a store writer: a round can count another revision's records | none found |
| D10 | Triage, telemetry and dismissal records | `review-records.ts:234-378` | sound, unused | none today | [#566](https://github.com/melian-agent/melian/pull/566) adds triage |
| D11 | Kinds with no payload check | `core/src/record.ts:46-71` | sound | closed | later builds of step 46 |
| D12 | Cell and cell version | `core/src/record-store.ts:140-147` | sound, unused | none | none needed |
| D13 | Publication lease | `core/src/lease.ts:47-135` | sound, unused | none | none needed |
| D14 | Record and payload versions | `core/src/record.ts:239`, `core/src/record-payloads.ts:292-302` | hand version | closed | [#437](https://github.com/melian-agent/melian/issues/437), generally |
| D16 | `owned`, the export's ownership test | `review.ts:3699-3706` | judged reuse | closed | none needed |
| D17 | Judgement key, `keyOf` | `state-git/src/state-tree.ts:57-59` | sound | none | none needed |
| D18 | Leftover owner, `Owner` | `state-git/src/owner.ts:15-71` | thin key, marked | closed, in an unsupported setup only | none needed |
| D19 | Host facts, `hostFacts` | `core/src/host.ts:20-42` | thin key, marked | not verified | none found |

Rows C1, C2 and D15 do not appear: they were the same stored things as A1, B7 and A5, read from another side, and their findings are folded into those rows.

## The rows in detail

### A. Deterministic checks and caches

How a check run works, in one paragraph, since every row below leans on it. `runChecks` builds one request from everything it thinks decides the result (`packages/pipeline/src/checks.ts:673-723`), keys it with `KeyedRequest.of` (`check-request.ts:115`), and looks the run up by `base head tier <first 16 hex digits of the key> 0` (`checks.ts:777`). A hit returns the earlier task's outcome (`checks.ts:803-804`). A miss creates a `melian.checks` task, which creates one `melian.check` task per deterministic check (`checks.ts:547-583`). Each child's last commit writes the check's findings into the findings document under the revision and the check's name, replacing whatever was there (`checks.ts:468-477`, `findings.ts:481-509`), and writes a small record (`ran`, a count, notes) into the task's own outcome. The review takes the records from the task (`review.ts:2425-2426`) and the findings from the document (`adjudication.ts:259`). Nothing joins the two.

#### A1. A check's sightings in the findings document

- **What and where:** each static or guardrail finding a check reports, stored as a sighting in `melian.findings` (`packages/pipeline/src/findings.ts:101-128`), at `items[id].sightings[revision][check@version]` (`findings.ts:68-74`, `130-132`). For a static check, `version` is the tool's version (`packages/core/src/static.ts:498`).
- **Address:** the finding ID, then `Revision.key` of base and head, then `check@toolVersion`. None of these names the run or its request.
- **Writers:** `replaceCheckFindings` (`findings.ts:481-509`), called only from the check task's terminal commit (`checks.ts:474`). It removes every sighting of that check at that revision, of any version (`findings.ts:496-500`), then writes its own. So any run of the check at the revision replaces any other run's findings. The only gate is `ownsMutation` (`checks.ts:364-368`, `472`), which returns true for every check but `static.mutation`.
- **Readers that decide:** adjudication reads the revision's sightings for the producers the manifest names, by check name and the tool version on the record (`adjudication.ts:207-212`, `259`; `review.ts:2158-2177`; `findings.ts:710-740`), and decides the verdict from them. The export reads the same slot (`review.ts:3144-3175`).
- **Kind:** shared slot.
- **Wrong answer:** the sequence in [issue #562](https://github.com/melian-agent/melian/issues/562), which holds at this head. (1) Run B, under request key KB, finds a blocking Biome finding at revision R. (2) Run A, under key KA, started earlier, finishes later with none. Its terminal commit removes B's sighting (`findings.ts:496-507`). (3) B's next review finds KB's task by key (`checks.ts:803-804`) and reuses its outcome, whose record says `ran` with one finding. (4) Adjudication reads the slot, finds nothing, and the verdict passes. The record's count is never compared with the slot: the verdict's stored check record has no count field (`packages/core/src/adjudication.ts:424-449`). Two runs differ in key whenever the configuration, the policy source, the tool pins, the install, the host, the trust or `LANG` differ (`checks.ts:689-713`). One clone reviewing one range with two Melian builds, or once with the working tree's policy and once with the base's, is enough. A tool-version difference makes it worse, not better: B then reads only `biome@B-version` sightings, and A's write removed them. **Fails open:** a blocker is dropped and the review passes.
- **Guards:** for `static.mutation` only, the `owners[revision]` authority (A6) stops a retired run from writing. The adjudication attach key includes the findings version (`adjudication.ts:203-205`), which only makes sure the dropped finding is re-adjudicated as dropped. [Pull request #557](https://github.com/melian-agent/melian/pull/557) adds a stamp that guards the export only, as its body and [issue #562](https://github.com/melian-agent/melian/issues/562) say.
- **Covered by:** [issue #562](https://github.com/melian-agent/melian/issues/562) (verdict), [issue #528](https://github.com/melian-agent/melian/issues/528) and [pull request #557](https://github.com/melian-agent/melian/pull/557) (export).

#### A2. Check run attach: `ChecksDocument.tasks` and `identityKey`

- **What and where:** `melian.checks`, version 4 (`checks.ts:102-115`). `tasks` maps a run's identity, short of its task, to the latest task (`checks.ts:96-97`). `runs` holds each run's records by full identity (`checks.ts:94-95`).
- **Address:** `identityKey` joins base, head, tier, the first 16 hex digits of the check request key, and the task (`checks.ts:144-146`, `717`). The lookup uses task `0` (`checks.ts:777`). The field that holds the prefix is called `policy` (`checks.ts:74`), though it is the request key.
- **Writers:** `start` in `runChecks` (`checks.ts:799-822`). It replaces `tasks[key]` with a new task when the old one is stale, a restart is needed, or the request is not reusable (`checks.ts:803`, `816`). `runs[run]` is written by the parent task (`checks.ts:584`, `619`) and each child (`checks.ts:475`), under a key that holds the task ID, so one task's records are never replaced by another's.
- **Readers that decide:** `start` decides reuse (`checks.ts:802-804`). `readCheckRecords` (`checks.ts:862-870`) is exported but no source in `packages/cli`, `packages/github` or `packages/pipeline` calls it (grep). Telemetry reads `tasks` and `runs` for display (`telemetry.ts:628-645`).
- **Kind:** sound in shape: reuse is a lookup by key, with `checkReusable` deciding from inputs, not stored state. Thin key in one respect: the lookup holds 64 bits of the key. The code marks it: `CheckRun.request` carries the full key (`checks.ts:86-87`, `849`).
- **Wrong answer:** none found in the attach itself. A reused task's outcome holds records, not findings; the findings are A1's slot. A reused task whose outcome is `failed` throws on every review (`checks.ts:853-855`) until `--rerun`: **fails closed.**
- **Guards:** `reusable` (`checks.ts:803`), the `restart` from lost mutation authority (`checks.ts:824-837`).
- **Covered by:** none needed beyond A1.

#### A3. The check request key, `checkRequest`

- **What and where:** `check-request.ts:115-135`, built from the facts gathered in `checks.ts:689-713`.
- **Address:** SHA-256 of `canonicalJson({ producer: "check", request })` through `KeyedRequest.of` (`check-request.ts:116`). The request holds the configuration less `output` and `publish.emoji` (`check-request.ts:60-64`), the policy source less the preference file's path (`67-69`), Melian's tool pins, Biome's and tsc's source and version, the install digests, Stryker's facts, trust, cold flag and `LANG` when mutation is on, `checkVersions`, the host facts, and a working tree's policy text (`118-133`).
- **Writers:** not stored by itself. It becomes A2's key and `CheckRun.request`.
- **Readers that decide:** A2's attach; the check record key in the export (`review.ts:3146`).
- **Kind:** thin key. Inputs left out, and whether the code marks them:
  - `PATH`, `HOME` and `TMPDIR` under mutation. Not marked: a run under other values is reused on the same host. Stated in the doc comment (`check-request.ts:110-113`) and the identity table.
  - What the task actually ran with after a crash. The facts are read in the reviewing process (`checks.ts:689-713`), but a child task resumed in a new process runs the tools that process resolves (`checks.ts:247-267`). Only `LANG` travels in the input (`checks.ts:166`, `571`). Not marked.
  - Bun's install. `installDigests` keys Bun's lockfile only (`mutation-static.ts:121-133`), and a Bun lockfile counts as recorded (`mutation-static.ts:155-157`), so `identified` stays true. Not marked.
  - Melian's own check code, which stands in the key only as `checkVersions` (A4). Not marked.
  - Marked, so the run is never reused: an unreadable working-tree policy (`policy: "unread"`) and an unidentified install (`check-request.ts:104-106`, `mutation-static.ts:159-165`).
  - The host's case folding is asked of the system's temporary directory (`packages/core/src/host.ts:20-26`), the default `runIdentity` uses (`checks.ts:710`). Biome and tsc resolve from the checkout's `node_modules`, which can sit on another volume. Not verified whether this changes any result.
- **Wrong answer:** for each unmarked input: a review keyed with facts F reuses a run whose tools ran with facts G. Example: a crash leaves a `melian.check` task pending; `npm install` moves Biome; the next process resumes the task, runs the new Biome, and the result is recorded under the old key; a later review under the old install reuses it. **Fails open** when G finds less than F would (a dropped finding).
- **Guards:** `keyCoverage` tests are claimed in the identity guideline for `KeyedRequest`; not checked here. `checkReusable`.
- **Covered by:** [issue #458](https://github.com/melian-agent/melian/issues/458) (`HOME`, `TMPDIR`), [issue #459](https://github.com/melian-agent/melian/issues/459) (resume), [issue #437](https://github.com/melian-agent/melian/issues/437) (code). Bun's install: none found. Case folding: none found.

#### A4. `checkVersions`, Melian's own code of each check

- **What and where:** a table of hand-raised numbers, `check-request.ts:46-56`.
- **Address:** hashed whole into the check request (`check-request.ts:126`).
- **Writers:** a developer, by hand. The comment says "nothing checks that you did until issue #437" (`check-request.ts:46-47`), meaning [issue #437](https://github.com/melian-agent/melian/issues/437).
- **Readers that decide:** A2's attach, through the key; `writesFixedText` (A5).
- **Kind:** hand version.
- **Wrong answer:** a pull request changes how `static.tsc` reports, say it starts finding a class of error it missed, and leaves `"static.tsc": 3`. A review after the upgrade reuses the completed run from before it, which never looked. **Fails open.** Two pull requests that both raise one number to the same value merge cleanly and leave one of the two changes unversioned.
- **Guards:** review only.
- **Covered by:** [issue #437](https://github.com/melian-agent/melian/issues/437).

#### A5. `fixedTextSince` and `writesFixedText`

- **What and where:** `check-request.ts:79-98`. It decides whether a run's request "asks for check code that stores no tool text", by comparing the request's `checks[check]` number with a hand-kept threshold.
- **Address:** the number A4 put in the request.
- **Writers:** a developer, by hand.
- **Readers that decide:** the export's `proven` (`review.ts:3149-3150`): a static sighting is shared only when this holds and the run ran in this process.
- **Kind:** hand version, deciding trust.
- **Wrong answer:** a change that makes a static check store tool text again, under a number at or above the threshold, shares that text through the record. This fails open on secrecy, not on the verdict.
- **Guards:** `ranInThisProcess` (`checks.ts:77-81`, `review.ts:3150`).
- **Covered by:** [issue #437](https://github.com/melian-agent/melian/issues/437); [pull request #557](https://github.com/melian-agent/melian/pull/557) changes this proof.

#### A6. Mutation authority, `owners[revision]`

- **What and where:** `ChecksDocument.owners` (`checks.ts:98-99`), one entry per revision naming the run identity, with its task, that may run and write the revision's mutation check.
- **Address:** `Revision.key` of the revision.
- **Writers:** `runChecks`'s retirement commit (`checks.ts:826-834`) and `start` (`checks.ts:817-820`). The latest run to ask replaces the entry.
- **Readers that decide:** `ownsMutation` at the child task's start (`checks.ts:400-407`), during the run through `holdsAuthority` (`checks.ts:431-435`, `mutation-static.ts:450-452`), and in the terminal commit (`checks.ts:472`); `abortRetiredMutation` (`checks.ts:325-339`).
- **Kind:** shared slot, by design: "the latest to ask" owns the revision.
- **Wrong answer:** none found that fails open. A retired run ends `aborted` and writes nothing; its next ask restarts (`checks.ts:831-835`). **Fails closed** (a rerun). This is the guard that A1 lacks for every other check.
- **Guards:** the three checks above, the commit that retires before it aborts (`checks.ts:823-837`).

#### A7. A rerun's kept records, `rerunOf`

- **What and where:** `checks.ts:737-755`, and the parent's `start` phase that copies them (`checks.ts:552-557`), with `CheckSources` copied in `checks.ts:808-815`.
- **Address:** the earlier task of the same A2 key.
- **Writers:** `runChecks` with `rerunFailed` (`checks.ts:840-846`).
- **Readers that decide:** the new parent copies each kept record into its result, so the review counts that check as run (`checks.ts:553-556`).
- **Kind:** judged reuse, by `repeated` (`checks.ts:739-741`): a record that did not fail and did not time out is kept.
- **Wrong answer:** a kept record says Biome ran; its findings are whatever A1's slot holds now, which another key's run may have replaced since. **Fails open** by the same path as A1. Otherwise it fails closed: a failed or timed-out check runs again.
- **Covered by:** [issue #562](https://github.com/melian-agent/melian/issues/562), by the same mechanism.

#### A8. The check task definitions and their versions

- **What and where:** `melian.check` version 4 (`checks.ts:375-385`), `melian.checks` version 3 (`checks.ts:525-532`), `melian.checks` document version 4 (`checks.ts:102-115`), `melian.mutation-processes` version 1 and `melian.check-sources` version 1 (`checks.ts:117-134`).
- **Address:** Pi Durable creates a task from its definition's name and version (`checks.ts:498-500`).
- **Writers:** a developer raises each by hand.
- **Readers that decide:** Pi's migration on resume. `melian.check` migrates any older input unchanged, adding `legacyTiming` (`checks.ts:380-384`). `melian.checks` refuses anything but version 2 (`checks.ts:529-531`). The document refuses below 3 (`checks.ts:111-113`).
- **Kind:** hand version, deciding migration.
- **Wrong answer:** a version-2 `melian.check` input has no `authority`; `ownsMutation` then returns false whenever `owners` holds the revision (`checks.ts:366-367`), so it ends aborted. **Fails closed.** Two pull requests raising one definition to the same number is the collision [issue #568](https://github.com/melian-agent/melian/issues/568) names; not checked here for these definitions.
- **Covered by:** [issue #437](https://github.com/melian-agent/melian/issues/437) in part (it is about check code, not definitions).

#### A9. `CheckSources`

- **What and where:** a document family, one per parent task, mapping each check to the child task that produced its record (`checks.ts:117-125`).
- **Address:** the parent task's ID (`checks.ts:549`).
- **Writers:** the parent's start (`checks.ts:575`) and a rerun's copy (`checks.ts:808-815`). Never replaced across tasks.
- **Readers that decide:** telemetry only (`telemetry.ts:638`), for display.
- **Kind:** sound.

#### A10. `MutationProcesses`

- **What and where:** `checks.ts:127-134`, the process tree a running mutation task started, by task.
- **Address:** the task's ID (`checks.ts:419-420`).
- **Writers:** the task's own `started` and `stopped` hooks (`checks.ts:417-429`) and its start and abort (`checks.ts:397-399`, `489-490`).
- **Readers that decide:** `terminateMutation` (`checks.ts:341-352`), which stops a crashed run's tree before the task runs again.
- **Kind:** sound. The recorded process carries pid and start time, which `terminateRecorded` matches (identity table, "Recorded process").

#### A11. Mutation cache partition

- **What and where:** `MutationCache`, a `partition.json` under `<state directory>/mutation/<name>` (`packages/pipeline/src/mutation-cache.ts:59-76`).
- **Address:** SHA-256 of `JSON.stringify({ version: 3, key })` (`mutation-cache.ts:71-73`), where `key` is base, policy commit, review target, `inputs` and `installation` (`mutation-cache.ts:20-26`; built at `mutation-static.ts:374-382`). `inputs` hashes only Stryker's binary version. `installation` hashes the lockfile digests, three package versions, Node's version and `mutationSelectionVersion` (`mutation-static.ts:168-191`). The head is left out on purpose (`mutation-cache.ts:18-19`).
- **Writers:** `publish` (`mutation-cache.ts:116-134`), from every mutation run that still holds authority (`mutation-static.ts:450-460`). It replaces the partition when `#replaces` says so (`mutation-cache.ts:180-189`): the head is the same, or the held head is its ancestor, or, across a force-push, the held task was made no later. The head's own tests, which run unconfined, can also write the file; the code says so (`mutation-static.ts:386-387`).
- **Readers that decide:** `earlier` (`mutation-cache.ts:83-95`) hands Stryker the last judged head's results when that run had the same trust and its head is an ancestor.
- **Kind:** shared slot (by design), judged reuse (`earlier`, `#replaces`), thin key (the head, and every input of the head's tests; marked by making the run `provisional`), hand version (`version: 3`, and the partition file's `"version":3` at `mutation-cache.ts:128`).
- **Wrong answer:** a reused result can be stale: a mutant Stryker takes as killed from an earlier head may survive now. That only reaches a run that was handed a report, which returns `provisional` (`mutation-static.ts:463`), and `provisional` is not `ran`, so the manifest is not complete and the review cannot pass (`packages/core/src/adjudication.ts:264-269`, `391-414`). Whether the run was handed a report is Melian's fact, never the file's (`mutation-static.ts:386-388`). **Fails closed.** The comment at `mutation-cache.ts:166` says the partition "never decides approval", and the code agrees.
- **Guards:** the `provisional` rule; the lock (`mutation-cache.ts:138-161`); `--cold`, which the check request keys (`checks.ts:704-705`).

#### A12. `mutationSelectionVersion`

- **What and where:** `packages/pipeline/src/mutation-vitest.ts:84`, `"vitest-selection@2"`, the version of the code that picks which tests run for each mutant.
- **Address:** hashed into `mutationInstallation` (`mutation-static.ts:187`), which enters both the partition key (A11) and the check request (`checks.ts:700`).
- **Writers:** a developer, by hand.
- **Readers that decide:** A2's attach through the check request; A11's partition.
- **Kind:** hand version.
- **Wrong answer:** a change to test selection that leaves the string alone keeps the check request's key, so a completed cold mutation run from before the change is reused. If the old selection missed a test that kills a mutant, the old survivor stays; if it ran a test it should not have, a survivor is hidden. The second **fails open.** `checkVersions["static.mutation"]` is a second hand number over the same code (A4).
- **Covered by:** [issue #437](https://github.com/melian-agent/melian/issues/437).

#### A13. Enola graph cache, `GraphSnapshot.key` and the Enola policy hash

- **What and where:** `GraphCache` under `<state directory>/graphs/<key>` (`packages/pipeline/src/graph-cache.ts:34-127`), holding Enola's artefacts and an `entry.json`.
- **Address:** SHA-256 of tree, Enola version, the binary's digest and the policy hash, joined by NUL (`packages/core/src/graph.ts:60-65`). The policy hash covers the base's policy files, the effective configuration, the flags and `schema: 1` (`packages/core/src/enola.ts:72-82`). The tree is the commit's git tree (`enola-static.ts:135-138`).
- **Writers:** `EnolaRun.#generate` after Enola generates (`enola-static.ts:191`). `store` never replaces a valid entry (`graph-cache.ts:96`, `103`, `107`); it replaces only an unreadable one (`graph-cache.ts:108-121`).
- **Readers that decide:** the Enola check restores a cached graph and runs `enola check` over it (`enola-static.ts:139-153`, `200-221`), so the graph decides Enola's findings. Caller context reads only cached graphs (`enola-static.ts:229-233`).
- **Kind:** sound: content-addressed, never replaced. Hand version (`schema: 1`, `format_version: 1` at `graph.ts:32`).
- **Wrong answer:** none in the key. The read checks the entry against its parts and the artefacts against their recorded hashes (`graph.ts:109-120`), but both sit in the same writable directory, so anyone who can write the state directory can plant a self-consistent graph. That includes a trusted head's tests under mutation, which run unconfined as the user. A planted graph can drop Enola findings: **fails open**, but only past the trust model's assumption that a writer of the local store is trusted.
- **Guards:** bounded no-follow reads (`graph-cache.ts:14-26`); artefact hashes.
- **Covered by:** none found; this is the "whoever can write the store can plant a result" limit [issue #568](https://github.com/melian-agent/melian/issues/568) asks the model to state.
- **Not verified:** whether `enola check` reads anything beyond the restored artefacts and the worktree.

#### A14. Coverage cache producer index

- **What and where:** `CoverageCache`, `<state directory>/coverage/<graph key>/` (`packages/pipeline/src/coverage-cache.ts:22-145`). Artefacts are content-addressed (`coverage-cache.ts:81`). Beside them, one index file per kind and producer names the current artefact (`coverage-cache.ts:53-56`, `83-86`).
- **Address:** the graph key, then the kind, then SHA-256 of the producer object (`coverage-cache.ts:43-47`, `54`). The producer is hand-written strings: `coverageMatcher = "enola-coverage@5/graph-coverage@1"` and `coverageCompiler`, TypeScript's version (`coverage-identity.ts:3-4`), `"review-transcript@1/review-coverage@1"` plus the review's identity, and `"test-coverage@1"`.
- **Writers:** `store` (`coverage-cache.ts:69-88`), by the Enola check for test coverage (`enola-static.ts:130`), by caller context for review coverage (`callers.ts:200`), and by the Enola spike in `packages/evals` for graph coverage (`evals/src/enola-spike.ts:208-212`). Each write renames over the index, so a later write replaces an earlier one.
- **Readers that decide:** none that decides a verdict. The IDs land in a check record's `coverage` (`review.ts:3387-3393`) and are exported (`review-records.ts:496-501`). Grep finds no reader that branches on them.
- **Kind:** shared slot (the index), hand version (the producer strings).
- **Wrong answer:** two producers that keep one string but compute differently replace each other's index. A reader is shown another artefact's ID. Decides nothing found.
- **Not verified:** whether any consumer of exported records reads `coverage`; only `packages/pipeline` and `packages/core` were searched.

#### A15. Coverage artefact IDs

- **What and where:** `packages/core/src/coverage-artifacts.ts:161-162`, `190`, and `packages/core/src/graph-coverage.ts`.
- **Address:** SHA-256 of `JSON.stringify` of the artefact's state, which relies on declared field order (identity guideline, "Canonical bytes").
- **Kind:** sound.

#### A16. Review coverage identity

- **What and where:** `packages/pipeline/src/callers.ts:197-199`, the `review` part of the coverage producer.
- **Address:** SHA-256 of the review's nonce and the lens conversations' IDs.
- **Kind:** sound for what it does: it is random on purpose, so two reviews never share a review-coverage index. It is a key in the code and not in the table.

#### A17. Tool cache directory

- **What and where:** `<state directory>/tools/<name>/<version>/<platform>/<archive sha256>` (`packages/pipeline/src/tool-cache.ts:74`).
- **Writers:** `materialise` (`tool-cache.ts:100-157`), staged and renamed.
- **Readers that decide:** every read re-verifies the archive and the binary against the pin's hashes (`tool-cache.ts:159-205`).
- **Kind:** sound.

#### A18. State directory hash, `CacheLocation`

- **What and where:** `packages/pipeline/src/tool-provisioning.ts:15-38`: the git common directory's `melian/`, or, under `MELIAN_STATE_DIR`, 16 hex digits of SHA-256 of the common directory's real path.
- **Kind:** sound. It names the host by design: it locates, it does not vouch.

#### A19. Static worktree lock reason

- **What and where:** `packages/pipeline/src/static.ts:604-605`, `melian-static pid <pid>`, and `removeStaleWorktrees` (`static.ts:622-641`).
- **Address:** the scratch folder's `melian-static-` prefix and the lock's pid.
- **Readers that decide:** `removeStaleWorktrees` removes any Melian worktree whose lock names no live pid, or does not parse (`static.ts:636-640`).
- **Kind:** sound for one build; a stored shape across builds, which AGENTS.md's learning on a missing static log records.
- **Wrong answer:** a build that locks differently looks dead to this one, which removes its worktree mid-run; that run fails with `worktreeFailed`. **Fails closed.** A reused pid keeps a dead run's worktree: harmless.
- **Guards:** the test AGENTS.md names, `packages/pipeline/test/mutation-static.test.ts`; not opened here.

#### A20. Cache scratch names

- **What and where:** `packages/pipeline/src/cache-scratch.ts:16-74`. Temporary names carry the writer's pid; `CacheScratch.open` removes a leftover whose pid is not running, or one past a day old.
- **Kind:** sound; a wrong match only keeps or removes a temporary. **Fails closed.**

#### A21. `melian store prune`

- **What and where:** `packages/pipeline/src/store-prune.ts`, removing graphs older than seven days for trees no ref or worktree holds, unreadable graphs after a day, orphan coverage, and mutation partitions untouched for 14 days (`store-prune.ts:9-11`, `198-229`).
- **Kind:** a reader that decides removal, not a stored result.
- **Wrong answer:** removing a live entry costs a regeneration or a cold start. **Fails closed.**

#### Not a stored thing

- `GraphMemo` (`packages/pipeline/src/graph-memo.ts:1-27`) holds parsed graphs in memory for one process, keyed by graph key. In-process lookups are outside the identity table by its own rule.
- `CompilerGraph` (`packages/pipeline/src/compiler-graph.ts`) keeps only in-memory maps; grep finds no cache on disk.
- `ranHere` (`checks.ts:77`) is an in-process `WeakSet`.

### B. Triage, lenses, probing, verification, walkthrough and the review index

#### B1. The lens task, `melian.lenses`
- **What and where:** one Pi Durable task per revision and lens selection. It spawns a conversation per lens run, runs them, and stores each run's outcome by run key as its result. `pipeline/src/review.ts:551`.
- **Address:** a task ID minted by the store. The review index names it for the revision (B4). Its input holds the runs, each with its request key (B3), and `reused`, the runs it copied (`review.ts:1838-1845`).
- **Writers:** `runLenses`, in one commit with the index entry, `review.ts:1845-1847`. A task's result is written once, when it ends. Nothing replaces a task; a later review creates another and aborts this one (`review.ts:1855-1857`).
- **Readers that decide:** the attach rule (B5), the copy rule (B6), `lensRecord`, which turns each outcome into the check record a verdict counts (`review.ts:2080-2120`).
- **Kind:** sound for the result itself. Hand version: `version: 7` at `review.ts:563`, with `LensTaskInput.upgrade` branching on `from` at `review.ts:304-318`.
- **Wrong answer:** the hand version only decides migration. A task stored before version 7 has no request key, so nothing copies from it and nothing attaches to it (comment at `review.ts:560-562`, `selectionOf` at `review.ts:1684-1686`). That fails closed: one full rerun. Two parallel pull requests that both raise it to 8 with different shapes would read each other's stores as their own; [pull request #536](https://github.com/melian-agent/melian/pull/536) raises it to 9 on top of [pull request #532](https://github.com/melian-agent/melian/pull/532). What a crossed migration does to each field: not verified.
- **Guards:** `superseded` stops a replaced task asking a model again, `review.ts:538-546` and `review.ts:595-597`. Tests: `pipeline/test/lens-requests-reopen.test.ts`.
- **Covered by:** hand-version collisions, [issue #437](https://github.com/melian-agent/melian/issues/437) (code versions), and the version-collision learning in `AGENTS.md`.

#### B2. The lens run key, `name@version@level`
- **What and where:** each run's key inside one task, `review.ts:2784`. It names the run's conversation in the checkpoint and its request IDs, `lens:<key>:<attempt>` (`review.ts:600-601`).
- **Address:** the lens name, the lens version (B18) and the level. No hash.
- **Writers:** the run builder, `review.ts:2782-2830`.
- **Readers that decide:** within a task only: which conversation and attempt a resume picks up (`review.ts:591-602`). Across tasks it also names the producer of a lens's sightings (B7).
- **Kind:** sound within a task. Thin key across tasks: it holds no route, budget or request, which is why the selection and the copy rule use the request key instead (B3).
- **Wrong answer:** none found within a task. Across tasks, see B7.
- **Guards:** a crash resumes at the attempt the checkpoint stored.
- **Covered by:** none needed.

#### B3. The lens request, producer `lens`, and the selection
- **What and where:** `lensRequest` builds each run's request and key, `pipeline/src/lens-request.ts:96-141`, called at `review.ts:2782`. `selectionOf` joins every first run's key with its request's key, sorted, `review.ts:1684-1686`. The review index stores that selection (B4).
- **Address:** `KeyedRequest.of("lens", …)`, the SHA-256 of canonical JSON of the request. It holds the run rendered under a fixed nonce without the caller section (route, thinking, level, budgets, instructions, prompt, standards paths, the probe environment), Pi Durable's and pi-ai's versions, the injection policy, every tool's name, description, schema and limits, `lensToolLimits`, the failover prompt, base, head, `escalateAt`, the escalation by the next run's key, the probing wording, the standards by text and source, and the mutant instrumenter for a run offered `list_mutants` (`lens-request.ts:103-139`). The probe environment holds the writer, the base's `trust.writers`, the timeout, the names of the `probe.read` paths and `probingHost` (`review.ts:2748-2756`; `probing.ts:287-292`).
- **Writers:** computed per review; stored in the lens task's input and in the index's selection.
- **Readers that decide:** the attach rule (B5) and the copy rule (B6), which treat a matching key as "the same question".
- **Kind:** thin key. Inputs it does not cover:
  - The contents of files under `probe.read`. Only their names are keyed (`review.ts:2753`). Not marked in code.
  - The installed dependencies of the code under test, which a probe reads. Excluded by the maintainer's ruling of 2026-11-16, recorded in `docs/guidelines/identity.md`. Not marked in code.
  - The lens tools' own code, what `run_probe` and the probe runner give a probe, and the code that handles the answer. Excluded by rulings of 2026-11-15 and 2026-11-16, pending [issue #437](https://github.com/melian-agent/melian/issues/437). Not marked in code.
  - The packages beneath Pi Durable, pi-ai and the instrumenter, which a reinstall can move under the same versions. Accepted 2026-11-15 and 2026-11-16; [issue #470](https://github.com/melian-agent/melian/issues/470).
  - The caller section and Enola graph, deliberately, under `bestEffort` (`lens-request.ts:136`). Marked in code.
- **Wrong answer:** a policy sets `probe.read: ["generated/schema.json"]`. A probing run reads clean against schema version 1. A build regenerates the file. The next review of the same head finds the same request key, copies the clean run, and reports nothing. Fails open: a dropped finding. The same sequence holds for a reinstall that changes what the code under test does, and for a Melian release that fixes `report_finding`'s acceptance or a tool's returned text without changing its description or schema: the old run's answer is reused.
- **Guards:** `keyCoverage` tests in `pipeline/test/lens-request.test.ts`; reuse tests in `pipeline/test/lens-reuse-review.test.ts`. `--rerun` asks again.
- **Covered by:** [issue #531](https://github.com/melian-agent/melian/issues/531) (read-path contents), [issue #437](https://github.com/melian-agent/melian/issues/437) (code), [issue #470](https://github.com/melian-agent/melian/issues/470) (Pi's dependencies). Installed dependencies of the code under test: none found; excluded by ruling.

#### B4. The review index, `melian.reviews`
- **What and where:** one entry per revision on the root conversation: the lens task, the selection, the adjudication task with its input as JSON, the verification task with its request key, and a caller record. `pipeline/src/review-index.ts:6-17`, defined at `review-index.ts:41-58`.
- **Address:** `Revision.key` of base and head. Inside the entry, a selection string (B3) and stored input keys.
- **Writers:** `runLenses` replaces the whole entry when it creates a lens task (`review.ts:1847`); `startVerification` writes `verification` and drops `adjudication` (`verification.ts:418-422`); `startAdjudication` writes `adjudication` (row C8); triage resets the entry when it creates a new decision task (`review.ts:2304-2306`); `callersFor` writes `callers` (`review.ts:1973-1979`). Every one of these replaces an earlier value.
- **Readers that decide:** `stillOwns` decides whether a review may write anything from a task's outcome (`review-index.ts:63-70`); `superseded` stops a replaced lens task (`review.ts:538-546`); `report_finding` refuses a replaced run's report (`lens-tools.ts:1601-1604`); the probe rerun task (`review.ts:1536-1540`); the attach and copy rules (B5, B6).
- **Kind:** shared slot. The revision holds one entry, and the latest review of it owns the slot whatever it asked. Hand version: `version: 4` at `review-index.ts:43`.
- **Wrong answer:** review A selects lens X under route R1. Review B of the same revision, run with `--model`, selects X under R2, takes the slot, aborts A's task and clears X's sightings. Review C under R1 finds B's task in the slot, and B did not ask R1, so X runs again. Fails closed: a needless rerun. A copy reads only the one task the slot names (`review.ts:1810-1812`), so alternating selections never reuse each other's runs. No sequence found in which the slot makes a verdict pass.
- **Guards:** every outcome-writing commit asks `stillOwns` in the same transaction. Tests: `pipeline/test/review-index.test.ts`, `pipeline/test/review-index-reopen.test.ts`.
- **Covered by:** none found for the slot itself. It is the "nothing should replace anything" case [issue #568](https://github.com/melian-agent/melian/issues/568) names.

#### B5. Attaching a review to an existing lens task
- **What and where:** the rule that lets a repeat review take an earlier lens task's results whole. Read ahead at `review.ts:1772-1779`, decided in the commit at `review.ts:1793-1803`.
- **Address:** the index entry's selection must equal this review's (B3, B4).
- **Writers:** none; it reads.
- **Readers that decide:** this rule decides whether any lens runs.
- **Kind:** judged reuse. After the key matches, `attachable` (`review-index.ts:88-93`) and `anyLensFailed` (`review.ts:1886-1897`) inspect the stored task. Without `--rerun`, `anyLensFailed` passes `probingOnly`, so only probing runs are judged by `runStands`; a failed non-probing run is attached as it is (`review.ts:1880-1885`, `1919-1924`). Thin key, marked: the caller context is not compared on attach, only on copy.
- **Wrong answer:** a lens ran on a model that answered, then the plan's judgement changed while the revision and route stayed the same. Without `--rerun` the non-probing run is attached without asking `refused`. Whether adjudication then refuses the run from its lineage: not verified (`ranOn` at `review.ts:1306-1328` builds the lineage from the finished model, which suggests it does). Separately, review 1 ran without an Enola graph and review 2 of the same head has one: review 2 attaches, and its lenses never saw callers. That fails open only in the weak sense of less context, which `bestEffort` accepts by design.
- **Guards:** a live or crashed task is attached and resumed; a task that ended aborted, faulted or orphaned is not (`review-index.ts:73`). `--rerun` judges every run.
- **Covered by:** none found.

#### B6. Copying lens runs, `copiesFrom`, `lensCopies` and `runStands`
- **What and where:** a new lens task copies each run whose request key an earlier run of the same revision had and that "stands". `copiesFrom` at `review.ts:1712-1740`; `lensCopies` at `pipeline/src/lens-reuse.ts:35-66`; `runStands` at `review.ts:1295-1305`; `callersShown` at `review.ts:1691-1697`.
- **Address:** the request key (B3), matched by `previous.lenses.find((run) => run.request === first.request)` (`lens-reuse.ts:47`). The earlier task must be the one the index names, completed, and shown the same callers: the graph's `GraphSnapshot.key` and the caveat (`review.ts:1723`).
- **Writers:** the new task's `reused` input field, `review.ts:1838-1845`. Copied outcomes are never written back.
- **Readers that decide:** this rule decides which lenses are asked.
- **Kind:** judged reuse. `runStands` reads the stored outcome: its record must read `ran`, the models it finished on must not be refused by the current plan, and every probe its prober tried must be conclusive (`review.ts:1301-1304`; `probesConclusive` at `probing.ts:304-309`). Thin key, inherited from B3.
- **Wrong answer:** the rule's own checks only ever refuse a copy, so they fail closed. The key under it fails open, as B3 says: a finished probing run with all probes conclusive is copied though the files it read have changed.
- **Guards:** `pipeline/test/run-stands.test.ts`, `pipeline/test/lens-reuse.test.ts`, `pipeline/test/lens-reuse-review.test.ts`, `pipeline/test/probing-repeat.test.ts`.
- **Covered by:** [issue #531](https://github.com/melian-agent/melian/issues/531), [issue #437](https://github.com/melian-agent/melian/issues/437).

#### B7. A lens's sightings in the findings document
- **What and where:** each finding a lens reports is stored in `FindingsDocument` (`pipeline/src/findings.ts:101`) under finding ID, revision and producer. `report_finding` writes it at `pipeline/src/lens-tools.ts:1641-1647` through `upsertFinding` (`findings.ts:391-440`).
- **Address:** `producerKey`, `<check>@<version>` (`findings.ts:130-132`), where a lens's source is `lensSource`: `lens.<name>` and `<version>@<level>` (`lens-tools.ts:126-128`). It holds no task and no request.
- **Writers:** every lens run's `report_finding`, which overwrites the same producer's sighting of the same ID (`findings.ts:431`). `clearSightings` removes the asked lenses' sightings when a new lens task is created (`review.ts:1830-1836`; `findings.ts:611-638`).
- **Readers that decide:** `readFindings`, which adjudication reads, filtered to the review's producers (`findings.ts:710-739`, `selected` at `findings.ts:232-245`).
- **Kind:** shared slot. Two runs of one lens at one level under different requests write the same slot. A copied run's findings are whatever the slot still holds: the copy assumes nothing cleared them.
- **Wrong answer:** none found. A replaced run cannot write: `report_finding` reads the index in its own commit and throws when the index names another task (`lens-tools.ts:1593-1604`). The new task clears the slot for every lens it asks in the commit that creates it. A copied lens is not cleared, so its earlier sightings stay.
- **Guards:** the index fence inside the write commit; `clearSightings` in the task-creating commit; the producer filter on read.
- **Covered by:** none needed today. [Issue #562](https://github.com/melian-agent/melian/issues/562) is the same shape on the static checks' side.

#### B8. `LensDocument`, a lens conversation's policy and spend
- **What and where:** per conversation: the policy the lens runs under, and what it spent. `lens-tools.ts:223-230`.
- **Address:** the conversation ID.
- **Writers:** the spawn commit writes the policy once (`review.ts:418`, `review.ts:480`, `verification.ts:192`); the tools add to `spend` (`lens-tools.ts:1621-1634`).
- **Readers that decide:** the budget check (`lens-tools.ts:1623`), the policy every tool reads (`lens-tools.ts:291`), telemetry.
- **Kind:** sound. One conversation, one writer task.
- **Wrong answer:** none found.
- **Guards:** scoped to its conversation.
- **Covered by:** none needed.

#### B9. `ProbingDocument`, a planner's plan and a prober's probes
- **What and where:** per conversation: the plan, each probe run with its result, attempts, skips, and the probe each finding rests on. `pipeline/src/probing.ts:218-238`.
- **Address:** the conversation ID.
- **Writers:** `record_plan`, `run_probe`, `skip_attack` and `report_finding` in that conversation. The plan is frozen in the commit that spawns the prober (`review.ts:676-681`).
- **Readers that decide:** `runStands` through `probesConclusive` (B6); the prober's spawn; verification's probe evidence.
- **Kind:** sound.
- **Wrong answer:** none found.
- **Guards:** `frozen` stops a late planner reply replacing the plan the prober holds.
- **Covered by:** none needed.

#### B10. Probe reruns, `ProbeReruns` and the `melian.probe-reruns` task
- **What and where:** before verification, a review runs each claim's probe again and stores the run on the root. Document at `probing.ts:760-771`; task at `review.ts:1521-1569`; started by `rerunProbes` at `review.ts:1586-1626`.
- **Address:** runs by revision, then by `rerunKey`: JSON of the claim's check, its version and the probe's ID (`probing.ts:751-753`). The owning task by revision, with a key that is `JSON.stringify` of the probe list, script, files and environment included (`review.ts:1609`).
- **Writers:** the task the document names for the revision, which replaces each probe's stored run (`review.ts:1549-1555`) and drops runs for probes it was not given (`review.ts:1560-1566`). A later review with other probes takes the revision over (`review.ts:1613-1617`).
- **Readers that decide:** the verifier is shown each rerun; a claim of a probing level is "reproduced" only when its rerun failed (`verification.ts:162-169`). The rerun task skips any probe whose stored run is conclusive (`review.ts:1541-1542`).
- **Kind:** shared slot (one owner per revision). Judged reuse: a stored conclusive run stands by `probeConclusive` (`probing.ts:317-319`). Thin key: `rerunKey` holds the probe's ID, not the host, the sandbox release, the contents of `probe.read` paths, or the install the probe ran against.
- **Wrong answer:** a probing run is copied (B6), so its probe IDs are unchanged. The earlier review stored a conclusive rerun that exited 0. The code under test, or a file under `probe.read`, has since changed so the probe would now fail. The rerun task skips it, the verifier reads "passed again", the claim is not reproduced, and the finding can be refuted. Fails open: a dropped finding. The other direction, a stale failure, keeps confirming a finding (closed).
- **Guards:** ownership fence before each probe and after each run (`review.ts:1536-1540`, `1552`); `stillOwns`. Tests: `pipeline/test/probing-repeat.test.ts`, `pipeline/test/probing.test.ts`.
- **Covered by:** [issue #531](https://github.com/melian-agent/melian/issues/531) for read-path contents. Installs: excluded by the ruling of 2026-11-16 ("a reinstall … copies the run and its conclusive reruns", identity guideline).

#### B11. The verification task and its verdicts
- **What and where:** `melian.verification`, one task per revision's final verification, `pipeline/src/verification.ts:114-300`; started by `startVerification`, `verification.ts:302-426`. Each verdict is stored in `FindingsDocument.verifications`, by finding ID, revision and producer, through `upsertVerification` (`lens-tools.ts:1331-1342`).
- **Address:** the task by the index's `verification: { task, input: key }` (`verification.ts:418-422`), where `key` is `verificationRequest`'s (`verification.ts:620-659`): the input less root, checkout path, nonce and reused outcomes; each candidate's identity (B12); the verifier's fixed text; `judges`; `cuts`; and the probe reruns read. The verdicts by `producerKey`, with no task or request.
- **Writers:** the verifier's `report_verdict`, which upserts per claim (`lens-tools.ts:1331`). `clearVerifications` before a new task (`verification.ts:406`) and before a wave (`verification.ts:703`). A replaced verdict is overwritten.
- **Readers that decide:** adjudication reads the verdicts with the findings (row C3); the attach decision reads the task's result (`verification.ts:385-394`).
- **Kind:** shared slot for the verdicts, guarded. Judged reuse on attach: with the key matching, it attaches to a task whose candidates all have an outcome even when one failed, unless `--rerun` (`verification.ts:388-389`). Thin key: the code that handles the verifier's answer, such as `report_verdict`'s evidence and lowering checks, is not keyed. Marked only in the identity guideline, pending [issue #437](https://github.com/melian-agent/melian/issues/437). Hand version: `version: 4` at `verification.ts:119`.
- **Wrong answer:** a release fixes `report_verdict` so a refutation with no evidence location is refused. Its schema and instructions are unchanged, so the key is unchanged. A repeat review of the same revision attaches to the old task, and the old refutation stands. Fails open: a dropped finding. Attaching to a failed task without `--rerun` should fail closed: the review adds `verifier` to the manifest when it verifies (`review.ts:3622`), so a verifier check record that did not read ran leaves the verdict not reviewed. Not verified: what record a task gets when some candidates failed and others did not (`review.ts:3550-3561`).
- **Guards:** `VerificationWaves.owns` inside `report_verdict`'s commit (`lens-tools.ts:1300-1308`); `stillOwns` and the selection check in `decide` (`verification.ts:358-359`). Tests: `pipeline/test/verification-request.test.ts`, `pipeline/test/verification-request-cut.test.ts`.
- **Covered by:** [issue #437](https://github.com/melian-agent/melian/issues/437).

#### B12. The candidate key, `candidateIdentity` and `candidateKey`
- **What and where:** what identifies one candidate's verification. `verification.ts:432-445`.
- **Address:** `KeyedRequest.of("verification.candidate", …)` over the candidate less `dismissals`, with the speaker reduced to its ID and each claim's stored verdict removed.
- **Writers:** computed; stored in a wave's entry (B13).
- **Readers that decide:** whether a wave's outcome stands for a candidate (B13).
- **Kind:** sound for what it decides. The exclusion of `dismissals`, the identity of each dismissal shown, is written down beside the destructure (`verification.ts:77-79`). The dismissed findings' claims, `dismissed`, stay in.
- **Wrong answer:** none found. A dismissal re-worded between a wave and the final step reuses the wave's sameness judgement, by design.
- **Guards:** `pipeline/test/verification-request.test.ts`.
- **Covered by:** none needed.

#### B13. Verification waves, `VerificationWavesDocument` and the wave version
- **What and where:** verification started while a lens task still runs. Document at `pipeline/src/verification-waves.ts:13-21`; `standing` at `verification-waves.ts:96-106`; `startWave` at `verification.ts:667-726`; `waveVersion` at `verification.ts:604-611`.
- **Address:** an entry per revision tied to one lens task (`verification-waves.ts:35-43`); each wave records its task, `waveVersion` (a key over `verifierVersion` and `verifierText()`), and its candidates' keys and claims.
- **Writers:** `startWave` appends a wave (`verification.ts:714-722`). `startVerification` drops unfinished waves and prunes finished ones (`verification.ts:409-416`). Triage deletes the revision's entry (`review.ts:2308`). A new lens task starts the entry afresh (`verification-waves.ts:47-51`).
- **Readers that decide:** `standing` decides whether a wave's outcome is copied into the final verification; `owns` decides whether a wave's verifier may still write (`verification-waves.ts:58-77`).
- **Kind:** judged reuse, over keys: the latest wave that verified the candidate key, under the same wave version, with no later wave touching its claims. A lookup plus an ordering rule. Hand version: `version: 1`.
- **Wrong answer:** none found that fails open. Every check refuses reuse.
- **Guards:** `pipeline/test/verification-waves.test.ts`, `verification-waves-unit.test.ts`, `verification-waves-document.test.ts`.
- **Covered by:** none needed.

#### B14. `verifierVersion`
- **What and where:** a 16-hex hash of the verifier's instructions, report schema, questions and probe-evidence wording and renderings. `pipeline/src/verification-instructions.ts:58-73`.
- **Address:** `JSON.stringify` of an object in declared order, SHA-256, cut to 16 hex digits. Not RFC 8785.
- **Writers:** computed at load.
- **Readers that decide:** the wave version (B13), the verification request (B11), and each verifier's `LensDocument` version.
- **Kind:** sound. It hashes text, never source.
- **Wrong answer:** none found. A rendering branch with no sample in `probeEvidenceRenderings` is not hashed; the comment says nothing enforces that (`probing.ts:776-779`).
- **Guards:** `pipeline/test/rounds.test.ts` pins the value for its fixtures, per `AGENTS.md`.
- **Covered by:** none needed.

#### B15. The walkthrough: `melian.summarize`, `SummaryIndex`, `SummaryResult` and the stored walkthrough
- **What and where:** the summary a pull request's ledger shows. Task at `pipeline/src/summarize.ts:178-242`; `SummaryIndex` at `summarize.ts:273-281`; `SummaryResult` at `summarize.ts:39-47`; the stored text in the verdict document's `routedWalkthroughs` (`summarize.ts:219-223`).
- **Address:** `SummaryIndex.tasks` by revision. The stored walkthrough by revision and then by `routeOf` (model and thinking). The task's input holds `walkthroughRequest`'s key (`summarize.ts:370-389`), used only to attach to a live task (`asks`, `summarize.ts:464-467`).
- **Writers:** only the task the summary index names writes or removes its own route's walkthrough (`summarize.ts:210-231`). `--rerun` replaces it.
- **Readers that decide:** `summarizeReview` returns without asking anything when one is stored for the wanted route (`summarize.ts:438-443`); publication posts it.
- **Kind:** judged reuse (`kept`, by revision and route). Thin key: the prompt, the instructions and the tool are not compared for a stored walkthrough. Not marked in code; listed in the identity guideline. Shared slot: one walkthrough per revision and route.
- **Wrong answer:** a release changes the summariser's instructions. Every revision that already has a walkthrough keeps posting the old one until `--rerun`. The walkthrough blocks nothing, so it is neither open nor closed for a verdict: a stale display.
- **Guards:** the index fence in the write commit; the attempt cap. Tests: `pipeline/test/summarize.test.ts`, `pipeline/test/walkthrough-request.test.ts`.
- **Covered by:** [issue #443](https://github.com/melian-agent/melian/issues/443).

#### B16. Triage: `DecisionDocument`, the decision task and the triage request
- **What and where:** one decision per revision and question set. Document at `pipeline/src/decisions.ts:22-37`; task at `decisions.ts:75-178`; `triageRequest` at `pipeline/src/triage-request.ts:33-52`; the attach rule at `review.ts:2242-2335`.
- **Address:** revision, then question-set name; the entry holds the request's `key`: the decider's name and version, the question set, the questions and the change under a fixed nonce, with the cut flag. The fallback decider's name holds its model and thinking (`pipeline/src/models.ts:131`, `cli/src/models.ts:68`) and its version hashes its fixed text (`decisions/src/fallback.ts:54-56`).
- **Writers:** `triage` replaces the entry with a new task when the key differs (`review.ts:2291-2300`); the decision task writes the answer into the entry it is named in (`decisions.ts:151-159`). Creating one resets the index entry and deletes the revision's verdict (`review.ts:2302-2313`).
- **Readers that decide:** the levels each lens runs at, and whether a lens is skipped within its band.
- **Kind:** sound for the key's reach: a lookup by key with the key stored beside the answer. A replaced entry is a shared slot, but only a key mismatch replaces it. Thin key: the code that handles the decider's answer, `Decision.parse` and the band logic, is not keyed, pending [issue #437](https://github.com/melian-agent/melian/issues/437). Hand version: decision task `version: 2`; `triageQuestionSet` `version: "1"` (`core/src/triage.ts:12`), which the key does not depend on alone, since it holds the questions.
- **Wrong answer:** a release fixes how a decision maps to a lens's level. The key is unchanged, so a repeat review of the same revision attaches to the old decision and runs the lens at the old level. Fails open within the band policy allows. A failed decision under the same key is attached too, and every lens runs at its default level (closed).
- **Guards:** the stored key compared in the commit (`review.ts:2284`); the task writes only while the entry names it (`decisions.ts:154-157`). Tests: `pipeline/test/triage-request.test.ts`.
- **Covered by:** [issue #437](https://github.com/melian-agent/melian/issues/437).

#### B17. The caller record on the index entry, `callersFor`
- **What and where:** the caller notes and coverage IDs the first finishing call rendered into its records, so a repeat call writes the same records. `review.ts:1950-1980`; type at `review-index.ts:22-31`.
- **Address:** the index entry, stamped with the lens task it was computed from.
- **Writers:** the first call that finishes the lens task, once (`review.ts:1976`).
- **Readers that decide:** the records, the adjudication input and the verdict fingerprint of a repeat call (`review.ts:1966-1967`).
- **Kind:** sound: a record of another task is ignored (`review.ts:1966`).
- **Wrong answer:** none found.
- **Guards:** the task stamp and `stillOwns`.
- **Covered by:** none needed.

#### B18. The lens `version`
- **What and where:** a 12-hex hash of a lens's behaviour fields. `core/src/lens.ts:356-362`.
- **Address:** `JSON.stringify` in declared order, less `file`, `nearer`, `resolution` and `emoji`.
- **Writers:** computed when a lens is loaded.
- **Readers that decide:** the run key (B2), the producer of sightings (B7), and the lens request through the run.
- **Kind:** sound, for what it names. Its bytes depend on field order, which the identity guideline lists under "Canonical bytes".
- **Wrong answer:** none found.
- **Guards:** lens tests in core (not opened).
- **Covered by:** none needed.

#### B19. `questionFingerprint`
- **What and where:** a 16-hex hash of a question's ID, text and options. `core/src/decider.ts:16-19`.
- **Address:** `JSON.stringify` of an array.
- **Writers:** whoever records an answer for the recorded decider.
- **Readers that decide:** only `RecordedDecider`, which refuses a recorded answer whose fingerprint differs (`decisions/src/recorded.ts:60-69`). No source in the five audited packages calls it.
- **Kind:** thin key, marked: the fingerprint is optional (`recorded.ts:13-16`), and an answer recorded without one is accepted for a changed question.
- **Wrong answer:** a recording without a fingerprint answers a changed question. Whether `RecordedDecider` runs outside tests and evals: not verified.
- **Guards:** `decisions/test/deciders.test.ts` (exists; not read).
- **Covered by:** none found.


### C. Findings, dismissals, verdicts, rounds, publication and comparison

A static check's sightings in the findings document are row A1, and a lens's sightings are row B7. This section read both from the verdict's side and reached the same conclusions, so they are not repeated here.

#### C3. Verification records in the findings document
- **What and where:** each verifier judgement of a claim, `items[id].verifications[revision][producer][verifierVersion]` (`pipeline/src/findings.ts:73`).
- **Address:** finding ID, `Revision.key`, `producerKey`, then the verifier's version string.
- **Writers:** `upsertVerification` (`findings.ts:961-988`), from `report_verdict` (`lens-tools.ts:1331`). A write for one version replaces that version's entry after `VerificationRecord.after` keeps the stronger of the two (`findings.ts:975`), and re-inserts it last. `clearVerifications` (`findings.ts:939-958`) removes them; `upsertFinding` drops the producer's entry when the lens re-reports (`findings.ts:436`).
- **Readers that decide:** `judgedAt` (`findings.ts:888-905`) and `verificationClaims` (`findings.ts:747-767`) take `Object.values(...).at(-1)`, the version written last, not the version the adjudication's provenance names.
- **Kind:** shared slot (the latest-written version decides).
- **Wrong answer:** it would fail open if two verifier versions' verdicts on one claim stood side by side and the older were written last: adjudication would read the older answer, possibly `refuted`. The guards below look to make that unreachable. A new verification task clears, in the commit that starts it, every claim it does not keep from a wave of the same wave version (`verification.ts:404`, `findings.ts:939-958`), and the wave version holds `verifierVersion` (B13). Only the task that owns the revision can then write, since `report_verdict` checks `VerificationWaves.owns` in its own commit (`lens-tools.ts:1300-1308`). So the slot appears to hold one version per claim at a time. **Fails closed** on this reading.
- **Guards:** the clear on start; the ownership test in the write commit; the verifier version in the verdict's provenance (`adjudication.ts:83-89`), which nothing compares with the record read.
- **Covered by:** none needed if the reading above holds.
- **Not verified:** not every caller of `upsertVerification`, nor every path that keeps a claim, was traced, so this cannot rule out a sequence that leaves two versions in one claim's map. The reader would still take the last written, not the one its request named.

#### C4. The findings version counter
- **What and where:** `versions[revision]` in the findings document (`findings.ts:84-89`), a count of writes that could change a read of that revision.
- **Address:** `Revision.key`.
- **Writers:** `bump` (`findings.ts:647-652`), called by every write in the module: `upsertFinding` (`:417`), `replaceCheckFindings` (`:510`), `dismissFinding` (`:604`), `clearSightings` (`:633`), `replaceInheritances` (`:882`), `clearVerifications` (`:957`), `upsertVerification` (`:986`), `reopenDismissals` (`:362`). It only grows.
- **Readers that decide:** the adjudication input (`review.ts:3626`, `adjudication.ts:208`), which decides whether a repeat review attaches to an earlier adjudication; `undecidedVerdict` at publish (`publish.ts:1315-1333`).
- **Kind:** sound locally. It is a counter of one store, not a hash of what was read, so it means nothing to another host.
- **Wrong answer:** none found on one host. The counter says that something changed, not what; row A1 shows a change it records faithfully and nothing then judges.
- **Guards:** every writer in `findings.ts` bumps it; the read comes before the findings read so a racing write makes the verdict look older (`adjudication.ts:256-258`).
- **Covered by:** none needed.

#### C5. A dismissal on a finding's lifecycle
- **What and where:** `items[id].lifecycle` (`findings.ts:42-56`): status, dismisser, reason, time, the accepted trigger and proof, the severity shown, the frozen sighting, and history.
- **Address:** the finding ID alone, across every revision of the changeset. The ID hashes file, rule, normalised snippet and occurrence or discriminator (`core/src/findings.ts:693-714`).
- **Writers:** `dismissFinding` (`findings.ts:520-606`), from `recordDismissal` (`pipeline/src/dismiss.ts:162`). A new dismissal replaces the old one, which moves to `history`. `upsertFinding` reopens it at any revision when the reopen rule says the trigger changed (`findings.ts:451-473`), and `reopenDismissals` does the same for attached tasks (`findings.ts:346-366`).
- **Readers that decide:** `readFindings` (`findings.ts:729-735`) marks the finding dismissed at every revision while the lifecycle says so, so adjudication counts it out and the status passes.
- **Kind:** judged reuse, by the rule `reopens` (`findings.ts:332-344`): a dismissal carries to a new head while its trigger hash, or the hunks that proved an affected cause, are unchanged.
- **Wrong answer:** a finding dismissed at P3 is sighted at a later head with the same ID and trigger but at P0, say a lens finds a worse failure in the same lines. The lifecycle stays dismissed and the verdict passes. The severity the dismissal was made at is recorded (`findings.ts:557`) but read only to fence inherited dismissals (`findings.ts:1137`); no other reader was found. Fails open. A dismissal also carries when code outside the snippet and proof hunks changes what the snippet means; that is the decided behaviour.
- **Guards:** the reopen rule; `dismissal-trigger.test.ts`, `dismissal-content.test.ts` and `dismiss.test.ts` in `pipeline/test/`.
- **Covered by:** none found for the severity rise. [issue #481](https://github.com/melian-agent/melian/issues/481) makes the dismissal a shared record and does not change the carry rule.

#### C6. Inherited dismissals, and the dismissal's identity `identityOf`
- **What and where:** `inherited[revision][id]` (`findings.ts:87`), a link from a restated finding to a dismissed root, bound to `identityOf` of the root's lifecycle (`findings.ts:818-830`).
- **Address:** `Revision.key`, then finding ID. `identityOf` is 16 hex digits of SHA-256 over `JSON.stringify` of six lifecycle fields in a fixed order.
- **Writers:** `recordInheritances` (`findings.ts:1109-1147`) after verification, which replaces the revision's whole set through `replaceInheritances` (`findings.ts:861-885`).
- **Readers that decide:** `standing` (`findings.ts:806-815`) and `readFindings` make a linked finding read `dismissed` while the root's identity still matches.
- **Kind:** judged reuse, by a model's answer: the verifier's `matches[root] === "same"` (`findings.ts:1127-1132`), fenced by the root's recorded severity and the trust floor (`findings.ts:1137-1138`, `:1098-1100`).
- **Wrong answer:** the verifier wrongly answers `same` for a new defect at no higher severity than the root's and outside the trust floor; the finding inherits the dismissal and the verdict passes. Fails open, within the fence the decision accepted. A replaced or reopened root changes `identityOf`, so the link lapses and the finding reads live: fails closed.
- **Guards:** the identity binding; severity fence; trust floor. Decision `docs/decisions/2026-11-08-dismissal-carries-to-restatement.md`.
- **Covered by:** none needed beyond the decision.

#### C7. The verdict slot, `melian.verdicts`
- **What and where:** `verdicts[revision]`, with `provenance`, `decisions`, `details` and walkthroughs beside it (`pipeline/src/adjudication.ts:104-117`, document at `:161-180`).
- **Address:** `Revision.key`. One verdict per revision, whatever policy, route or check run decided it.
- **Writers:** the adjudication task's last commit (`adjudication.ts:309-322`) replaces it; `RoundWriter.mint` (`rounds.ts:133-147`) and triage (`review.ts:2309-2314`) delete it when a new round or decision starts.
- **Readers that decide:** `recordDismissal` reads it to find what an ID names (`dismiss.ts:126-129`); publication captures it and requires it to equal the round's saved copy (`publish.ts:1379-1446`); `readVerdict` for `melian findings` (`adjudication.ts:431-441`).
- **Kind:** shared slot.
- **Wrong answer:** none found beyond row A1: a write records nothing once the review index names another adjudication task (`adjudication.ts:311-314`), so a stale task cannot replace a newer verdict.
- **Guards:** the index ownership test; publication's deep equality with the round (`publish.ts:1441-1444`); `undecidedVerdict` (`publish.ts:1307-1334`).
- **Covered by:** none needed.

#### C8. The adjudication task and its attach key
- **What and where:** `melian.adjudication` (`adjudication.ts:230-336`), and the review index's `adjudication: { task, input }` (`pipeline/src/review-index.ts:15`).
- **Address:** `JSON.stringify` of the whole task input less `details` (`review.ts:1991`; the dismissal's form at `dismiss.ts:184`), compared as a string with the one entry the index holds per revision (`review.ts:1996-2002`). Plain JSON in construction order, not canonical bytes.
- **Writers:** `startAdjudication` (`review.ts:1962-2010`) and `recordDismissal` (`dismiss.ts:193-199`) replace the index entry when the key differs.
- **Readers that decide:** a repeat review attaches to the named task when the key, the round's check run and `attachable` agree, and prints its stored verdict without deciding again.
- **Kind:** shared slot (one entry per revision) and thin key. The key holds the input, but not the code that decides from it: `Adjudication` in `core/src/adjudication.ts`, `readFindings`'s merge, `configsFor`. Only the task's hand-raised `version: 7` (`adjudication.ts:239`) moves with that code, and an existing task migrates rather than reruns (`:240-249`). The code does not mark this gap.
- **Wrong answer:** a release fixes adjudication so that some finding now blocks. A repeat review of a head the old build reviewed computes the same input, attaches to the old decided task, and prints the old pass. Fails open until a new head or `--rerun`. A key-order change between builds gives a needless rerun, which fails closed.
- **Guards:** the index ownership test, `rounds.checkRun` (`review.ts:1998`), `undecided` and `failed` retries (`review.ts:1994`).
- **Covered by:** none found. [issue #437](https://github.com/melian-agent/melian/issues/437) asks for code versions for the checks, verifier, walkthrough and decider, and does not name adjudication.
- **Not verified:** whether some other input, such as the verifier version in provenance (`adjudication.ts:360`), always changes between releases in practice.

#### C9. The resolution policy fingerprint
- **What and where:** `configsFor` (`pipeline/src/configurations.ts:41-156`), returning `fingerprint` and `versionTwo`.
- **Address:** `3:` and 16 hex digits of SHA-256 over canonical JSON of each finding path's resolution table, layers, rule aliases as sets and lens defaults, and each lens report's declared default with its name and scope (`configurations.ts:146-149`). Only paths that hold a finding are hashed (`:76-112`).
- **Writers:** the review, into the adjudication input (`adjudication.ts:193`) and the account record (row D8).
- **Readers that decide:** the adjudication task refuses a verdict when the recomputed value differs (`adjudication.ts:274-290`), so a dismissal cannot decide under a changed working-tree policy; `RecordedRound.verdict` reads a round as not reviewed under another policy (`pipeline/src/recorded-round.ts:104-111`).
- **Kind:** hand version (`fingerprintVersion = 3`, `configurations.ts:19`, chosen by hand, with version 2's recipe kept as a branch at `:150`). Otherwise sound for what it decides.
- **Wrong answer:** none found that fails open. Removing a scoped lens whose default the root repeats refuses a dismissal needlessly, which the maintainer accepted on 2026-11-17 (identity guideline row). Fails closed.
- **Guards:** `configurations.test.ts`, `dismiss.test.ts`, `caveats-reopen.test.ts`, `recorded-round.test.ts` in `pipeline/test/`.
- **Covered by:** [pull request #525](https://github.com/melian-agent/melian/pull/525) (merged).

#### C10. `Verdict.fingerprint`
- **What and where:** `core/src/adjudication.ts:799-829`.
- **Address:** 16 hex digits of SHA-256 over `JSON.stringify` of the stored verdict less dismissal details, deciding file, guardrail match and caveats. It hashes an output, by purpose.
- **Writers:** computed, then stored as `StoredRevision.verdict` with `verdictRevision` (`publish.ts:96-101`), in a review marker, and in the ledger stamp (`github/src/ledger.ts:129`).
- **Readers that decide:** `postedVerdictOf` (`publish.ts:293-309`) skips posting a review when the last review at the head posted this fingerprint for this revision. The status is set every time regardless (`publish.ts:719`).
- **Kind:** sound for its purpose. It names what was posted, not what produced it.
- **Wrong answer:** none found. A change it leaves out, such as a new dismissal reason, is answered in the thread.
- **Guards:** `verdictRevision`; `publish.test.ts`, `publish-rounds.test.ts`.
- **Covered by:** none needed.

#### C11. Carrying posted threads, the `reusable` map
- **What and where:** `Verdict.publication` (`core/src/adjudication.ts:704-753`).
- **Address:** the finding ID in the previous revision's open set.
- **Writers:** the publish task records `open` per head (`publish.ts:94-106`).
- **Readers that decide:** a finding already open keeps its thread and is not posted again (`adjudication.ts:729-734`).
- **Kind:** judged reuse, by finding ID.
- **Wrong answer:** a finding whose severity or explanation changed at a new head keeps its old comment. The status and review body still count it. Neither open nor closed for the verdict; the thread can show stale text.
- **Guards:** none beyond the ID.
- **Covered by:** none found.

#### C12. Rounds and the round ID
- **What and where:** `melian.rounds` (`pipeline/src/rounds.ts:49-74`): `items[roundId]` with base, head, tasks, check run, saved verdict and provenance, and `current[revision]`.
- **Address:** `r<sequence>`, a counter local to the store (`rounds.ts:135`), made public as `<changeset ID>.r<n>` (`rounds.ts:248`). A round from before minting uses `legacyKey`, `k` and 16 hex digits of SHA-256 of the revision key (`rounds.ts:76-78`).
- **Writers:** `mint` when a new adjudication task starts (`rounds.ts:133-147`, from `review.ts:2005`); `keep` when a dismissal's adjudication joins the current round (`rounds.ts:149-158`, from `dismiss.ts:198`); `record` sets the saved verdict and replaces any earlier one (`rounds.ts:160-164`, from `adjudication.ts:317`).
- **Readers that decide:** publication binds to `current[revision]` and posts that round's saved verdict (`publish.ts:697-715`, `:1383`, `:1441-1444`); run details bind to it (`telemetry.ts:579-595`); `melian findings --round`; comparison and membership (C14, C16).
- **Kind:** shared slot (a dismissal replaces a round's saved verdict, so a round is not one verdict) and thin key (the ID names neither the store's host nor what the round read, and the code does not mark it).
- **Wrong answer:** a dismissal between `melian publish`'s binding commit and its task's post replaces the bound round's verdict; the task posts the newer verdict under the same round (`publish.ts:698-715`). Both are the writer's own decisions, so this posts a verdict that was not the one validated, but not a wrong one. Two clones of one pull request each mint `pull-….r1`; any record of round IDs gathered from both names two rounds by one ID. Neither sequence fails open on the verdict.
- **Guards:** publication's current-round and saved-verdict checks; `rounds.test.ts`, `round-legacy-key.test.ts`, `publish-rounds.test.ts`.
- **Covered by:** none found.
- **Not verified:** whether any committed comparison record mixes round IDs from two hosts.

#### C13. Pull-request round membership, `melian.pull-request-rounds`
- **What and where:** `pipeline/src/pull-request-rounds.ts:35-42`, a list of membership snapshots.
- **Address:** the changeset's root conversation; snapshots are appended with `version: prior + 1` (`:118`).
- **Writers:** `PullRequestRoundHistory.refresh` appends and never edits (`:63-148`); a rejected earlier member needs `--accept` (`:79-82`).
- **Readers that decide:** `melian compare` and its export read the latest snapshot.
- **Kind:** sound.
- **Wrong answer:** none found.
- **Guards:** the audit list; `pull-request-rounds.test.ts`.
- **Covered by:** none needed.

#### C14. Comparisons, and the external finding ID
- **What and where:** `melian.comparisons` (`pipeline/src/compare.ts:93-102`): `comparisons[roundId]` and `unattributed[revision]`. External finding IDs from `core/src/comparison.ts:238-244`, `:321-324`.
- **Address:** a comparison by round ID (C12) or revision key; an external finding by 16 hex digits of SHA-256 over length-prefixed source fields, without the reviewer.
- **Writers:** `melian compare` import and adjudication, which upsert by external ID.
- **Readers that decide:** `entries` re-matches each comparison against its round's current saved verdict at read (`compare.ts:71-82`); `melian compare stats` and the export.
- **Kind:** shared slot, by inheritance from C12: a dismissal that replaces a round's verdict changes what an adjudicated comparison is compared with.
- **Wrong answer:** a maintainer adjudicates a comparison against round r3's verdict; a later dismissal re-decides r3; the stats then compare the hand adjudication with another verdict. Affects evals only, never a merge.
- **Guards:** `2026-10-06-comparison-refuses-superseded-verdict.md`; `compare.test.ts`, `comparison-rounds.test.ts`.
- **Covered by:** none found.

#### C15. Publication record, `melian.published`
- **What and where:** `pipeline/src/publish.ts:228-241`; `revisions[head]` holds posted reviews, open and resolved findings, replies by `replyKey`, the pending round and the status (`:94-112`).
- **Address:** the head commit, then finding IDs and `replyKey` (`core/src/publication.ts:104-106`): finding ID, thread and `dismissalVersion` (`core/src/publication.ts:92-97`, 16 hex digits of SHA-256 over `JSON.stringify` of reason, dismisser, time and root).
- **Writers:** the publish task, one commit per post (`publish.ts:768-779` and following).
- **Readers that decide:** what to post, what is still open, which replies are owed (`publish.ts:318-332`), and the posted fingerprint (C10).
- **Kind:** sound. It records facts about the pull request, keyed by what they are about.
- **Wrong answer:** none found.
- **Guards:** signed markers read back before posting (C17); `published-v8-reopen.test.ts` to `published-v10-reopen.test.ts`, `published-versions-reopen.test.ts`.
- **Covered by:** none needed.

#### C16. The publisher document: secret and target
- **What and where:** `melian.publisher` (`publish.ts:279-287`): the marker secret, the latest validated target, and who published.
- **Address:** the changeset's root conversation; one target.
- **Writers:** `melian publish`'s binding commit (`publish.ts:1438-1456`) generates the secret once (`:1452`) and replaces the target and `publishedBy` each time.
- **Readers that decide:** a resumed publish task ends superseded when its target, trust or attribution differs from the recorded one (`publish.ts:613-638`).
- **Kind:** shared slot, by design: only the latest publish may post.
- **Wrong answer:** none found. A stale task fails closed. Losing the store loses the secret, so the next ledger starts afresh, which the design accepts.
- **Guards:** target comparison; `publish.test.ts`.
- **Covered by:** none needed.

#### C17. Signed markers
- **What and where:** `marker` and `verifyMarker` (`github/src/publication.ts:48-95`); `findPublished` (`github/src/provider.ts:716-760`).
- **Address:** HMAC-SHA256 under the publisher secret over the head, kind, finding ID or verdict fingerprint, round and dismissal version, cut to 32 hex digits.
- **Writers:** every post.
- **Readers that decide:** a rerun treats a post with a verifying marker as already made; a finding counts as listed when any review by the publisher's login holds its marker, whatever its revision (`provider.ts:741-744`).
- **Kind:** sound for recovery; judged reuse for the quiet advisory rule, which reads posted state across revisions.
- **Wrong answer:** an advisory listed at one head is not listed again at a later one, which the design names as its limit. Advisory only; neither open nor closed for the verdict.
- **Guards:** HMAC; `docs/decisions/2026-11-05-quiet-advisory-reviews.md`.
- **Covered by:** none needed.

#### C18. The ledger comment and its stamp
- **What and where:** `melian.ledger` (`publish.ts:243-251`) holds the posted ledger's ID, URL, stamp and author. The stamp is built in `github/src/ledger.ts:120-143`.
- **Address:** one ledger per changeset. The stamp holds base, head, round, verdict fingerprint, counts, lenses, a digest of the run details and a digest of the rendered body (`ledger.ts:124-137`, `:192`).
- **Writers:** the publish task, after each ledger write.
- **Readers that decide:** `Ledger.diff` (`ledger.ts:146-148`) leaves the comment alone when the stamps match; a stamp read back verifies against its marker and the visible body (`ledger.ts:74-112`).
- **Kind:** sound. The projection digest covers the visible body, dismissal reasons included.
- **Wrong answer:** none found.
- **Guards:** marker, stamp digest and body digest.
- **Covered by:** none needed.

#### C19. The publish task
- **What and where:** `melian.publish` (`publish.ts:568-1000` approximately), not replay-safe.
- **Address:** a new task per `melian publish`; its input carries the target with its round ID.
- **Writers:** `publishReview`, after the binding commit (`publish.ts:1438-1456`).
- **Readers that decide:** the task itself, which refuses when the index shows a review in progress, or the round is not current or undecided (`publish.ts:696-713`).
- **Kind:** sound.
- **Wrong answer:** none found beyond rows A1 and C8: it posts whatever verdict the store decided.
- **Guards:** as above; signed markers; `publish-rounds.test.ts`, `trust-floor-publish.test.ts`.
- **Covered by:** none needed.

#### C20. Run details and telemetry documents
- **What and where:** `melian.run-details` keyed by round ID (`pipeline/src/telemetry.ts:45-53`); `melian.model-usage` and `melian.model-attempts` keyed by task ID (`pipeline/src/token-usage.ts:10-29`, writers at `decisions.ts:122-147`); `melian.stage-timing` keyed by task ID (`pipeline/src/task-timing.ts:4-12`); `melian.prepare` keyed by revision (`pipeline/src/spans.ts:11-20`, writer at `:109`).
- **Address:** as listed.
- **Writers:** run details are written once per round and never replaced (`telemetry.ts:592-595`), only when the round is current, decided and its check run is the revision's owner (`:579-590`). `melian.prepare` is replaced by each review of the revision (`spans.ts:8-10`).
- **Readers that decide:** none decide a verdict. The ledger and `melian telemetry` show them.
- **Kind:** sound, except `melian.prepare`, a shared slot by revision that the run details copy only when it equals what the round read (`telemetry.ts:591`).
- **Wrong answer:** none found that reaches a verdict.
- **Guards:** the round checks above; `stage-telemetry-*.test.ts`, `token-telemetry.test.ts`.
- **Covered by:** none needed.

#### C21. Changeset IDs and `Revision.key`
- **What and where:** `pullRequestChangesetId` (`core/src/changeset.ts:195-202`), the range ID (`changeset.ts:524-528`), `Revision.key` (`changeset.ts:283-291`).
- **Address:** a pull request by SHA-256 of kind, provider, lower-cased owner and name, and number; a range by SHA-256 of kind, mode and the canonical names of base and head; a revision by `base..head` commit IDs.
- **Writers:** none; they choose the SQLite file (one per changeset) and every key above.
- **Readers that decide:** every row in this section, and `ComparisonStores` (`cli/src/comparison-stores.ts:46-56`), which opens each `<changeset ID>.sqlite`.
- **Kind:** sound. A range's ID names refs, not commits, by design, so its revisions are many.
- **Wrong answer:** none found. A dismissal on a range never reaches the pull request: fails closed.
- **Guards:** `isChangesetId` (`changeset.ts:186-188`).
- **Covered by:** none needed.
- **Not verified:** how `canonicalName` spells `HEAD` (`changeset.ts:523`); not read.

#### C22. Hand-raised document and task versions
- **What and where:** `version:` on `melian.findings` 11 (`findings.ts:103`), `melian.verdicts` 15 (`adjudication.ts:162`), `melian.adjudication` 7 (`adjudication.ts:239`), `melian.rounds` 4 (`rounds.ts:51`), `melian.published` 11 (`publish.ts:230`), `melian.ledger` 2 (`publish.ts:245`), `melian.publisher` 3 (`publish.ts:281`), `melian.publish` 7 (`publish.ts:571`), `melian.comparisons` 2 (`compare.ts:95`), `melian.pull-request-rounds` 1, `melian.run-details` 1, `melian.model-usage` 3, `melian.model-attempts` 1, `melian.stage-timing` 1, `melian.prepare` 1.
- **Address:** a number per definition, raised by hand when a shape changes.
- **Writers:** builders, in source.
- **Readers that decide:** Pi refuses a document from a newer version, and each `migrate` branches on the stored number (`findings.ts:109-127`, `adjudication.ts:132-156`, `publish.ts:182-219`, `rounds.ts:57-72`).
- **Kind:** hand version.
- **Wrong answer:** two branches raise one definition to the same number for different shapes, as `melian.adjudication` did on [pull request #131](https://github.com/melian-agent/melian/pull/131) and [pull request #135](https://github.com/melian-agent/melian/pull/135). A build of one then reads the other's document as its own shape, without migration. Usually a missing optional field, read as absent; whether that fails open depends on the field. The textual conflict at merge has caught each case so far, so this bites branch builds sharing one store (AGENTS.md learning on `MELIAN_STATE_DIR`).
- **Guards:** reopen tests per version (`published-*-reopen.test.ts`, `caveats-reopen.test.ts`, `legacy-*.test.ts`); Pi's newer-version refusal (`rounds.ts:227`).
- **Covered by:** [issue #437](https://github.com/melian-agent/melian/issues/437) is about code versions, not shape versions; none found for shape versions.


### D. The shared record

#### D1. Record ID, `SharedRecord.id`
- **What and where:** the name of one record, `core/src/record.ts:202`, `216`.
- **Address:** SHA-256 of the whole envelope's canonical bytes, signature included (`record.ts:216`, `235`). Canonical bytes are RFC 8785 (`record.ts:93-120`).
- **Writers:** every adapter files a record by its ID. Memory: `records.set(record.id, record.bytes)` (`core/src/record-store.ts:125`). Directory: a rename onto the path the ID names (`core/src/directory-record-store.ts:153-158`). Git: only paths the tree lacks (`state-git/src/git-record-store.ts:166-169`). A write can only put the same bytes back under the same ID.
- **Readers that decide:** `SharedRecord.read` refuses bytes that are not canonical or do not hash to the filed ID (`record.ts:305-307`). `RecordSet` and `RecordedRound` name records by ID.
- **Kind:** sound.
- **Wrong answer:** none found.
- **Guards:** canonical-bytes check and ID check on read; the conformance suite in `core/src/testing.ts`.
- **Covered by:** not needed.

#### D2. Key hash, slot, `supersedes` and `replaces`
- **What and where:** `keyHash` (`record.ts:312-314`), the filing path (`record.ts:317-319`), `sharesSlot` (`record.ts:322-324`), the superseding kinds (`record.ts:71`), and a round's `replaces` (`record.ts:332-334`).
- **Address:** the slot is changeset, kind and key. `keyHash` is SHA-256 of the key.
- **Writers:** only `dismissal`, `post`, `status`, `ledger-comment` and `comparison` may carry `supersedes` (`record.ts:255-260`). No production code writes any of them: the dismissal builder sets no `supersedes` (`review-records.ts:374-377`) and has no caller. Every round is written with `replaces: []` (`review.ts:3206-3214`).
- **Readers that decide:** `RecordSet` counts a supersession only within one slot (`record.ts:380-384`). `standingRounds` drops a round another names in `replaces` (`record.ts:429-435`); no caller.
- **Kind:** sound.
- **Wrong answer:** none found. Every round stands, so `melian findings --records` shows every round (`commands.ts:821-847`).
- **Guards:** `supersedesNotAllowed` refusal (`record.ts:258-259`); slot check (`record.ts:383`).
- **Covered by:** [issue #395](https://github.com/melian-agent/melian/issues/395) decides who may replace what.

#### D3. The request key, `KeyedRequest.of`, `requestExclusions`, `requestJson`
- **What and where:** the one key function for a producer's request, `core/src/request-key.ts:75-91`. Exclusions: `request-key.ts:10-15`. Request bytes: `request-key.ts:30-43`.
- **Address:** SHA-256 of `canonicalJson({ producer, request })` (`request-key.ts:89`). Only `nonce`, `language`, `bestEffort` and `chosenBy` may sit beside it unkeyed (`request-key.ts:84-88`).
- **Writers:** none; it is computed.
- **Readers that decide:** every producer row that keys through it.
- **Kind:** sound as a mechanism. It covers what its caller passes, and no more. Rule 2 of the identity guideline holds only where the producer reads the request it was keyed from. The check run does not: `runChecks` keys `facts` (`pipeline/src/checks.ts:714`) and builds the task's input separately (`checks.ts:778-787`), and the task re-reads host facts and install when it runs, as [issue #459](https://github.com/melian-agent/melian/issues/459) says. That gap belongs to the check-run row, not here.
- **Wrong answer:** none in the mechanism.
- **Guards:** `keyCoverage` in `@melian-agent/core/testing`, by the identity guideline (`docs/guidelines/identity.md:126`); not read here.
- **Covered by:** not needed.

#### D4. Check record, producer `check.record`
- **What and where:** one check's result and sightings at a revision, built by `ReviewRecords.check` (`pipeline/src/review-records.ts:163-170`) and exported by `exportRound` (`review.ts:3143-3172`).
- **Address:** `KeyedRequest.of("check.record", { request, base, head, name })` (`review-records.ts:164`). `request` is the run's full request key, `run?.request ?? null` (`review.ts:3148`).
- **Writers:** `exportRound` only, once per review that owns its adjudication (`review.ts:3702-3706`). A repeat review under the same request whose sightings changed writes a second record with the same key and a new ID. Nothing replaces the first; both stay.
- **Readers that decide:** `RecordedRound` takes the result as a check record and the sightings as findings (`recorded-round.ts:161-164`), then adjudicates (`recorded-round.ts:112-121`).
- **Kind:** shared slot, thin key, hand version.
  - Shared slot: the sightings are not the run's output. They are read from the findings document's slot for that producer at that revision, `items[id].sightings[revision][check@version]` (`pipeline/src/findings.ts:167-178`, called at `review.ts:3144-3146`). Any run of the same check and version at that revision writes the same slot (`checks.ts:758-760`, "each replacing its findings at the revision").
  - Thin key: the key names the request of the run the review holds, and nothing ties that run to the sightings in the slot. The code says so for runs handed in (`review.ts:3147-3148`) but not for a run of this process whose slot another run overwrote.
  - Hand version: whether a static check's sightings may leave the host is decided by `writesFixedText`, which reads the hand-raised `checks` numbers in the request (`pipeline/src/check-request.ts:80-99`, `45-55`). See row A5.
- **Wrong answer:** the sequence of [issue #562](https://github.com/melian-agent/melian/issues/562). Runs A and B of one check, under different requests, review one revision. B finds a blocker. A finishes later with no findings and its commit empties the slot. B's next review reuses B's completed task (`checks.ts:801-804`), adjudicates the empty slot, and passes. `owned` holds, since adjudication read the current findings version (`review.ts:3702-3705`). The export then writes a `ran` record with no sightings under B's request (`review.ts:3162-3171`): `proven` is consulted only when there are sightings (`review.ts:3158`). A reader of that record passes too. **Fails open**, on the host and in the record.
- **Guards:** `foreignCheckRun` refuses a run handed in for another base, head or tier (`review.ts:2394-2406`). `proven`: a static sighting is shared only from a run `runChecks` returned in this process (`checks.ts:76-81`, a `WeakSet`) whose request asks for fixed-text code (`review.ts:3149-3150`), else the check is exported `failed`/`withheld` (`review.ts:3158-3161`). An Enola snapshot whose identities are not hashes is withheld (`review-records.ts:165-168`, `472-476`). `owned` (D16). The payload check ties each sighting to the record's check and version (`core/src/record-payloads.ts:329-339`, `354-361`).
- **Covered by:** [issue #562](https://github.com/melian-agent/melian/issues/562) (the stale run); [pull request #557](https://github.com/melian-agent/melian/pull/557), draft, for [issue #528](https://github.com/melian-agent/melian/issues/528), stamps the writing run's request key beside the sightings and withholds a check whose stamp differs, so it fixes the export side only, as #562 says; [issue #459](https://github.com/melian-agent/melian/issues/459) (a resumed run records under facts it did not run with).

#### D5. Lens record, producer `lens`
- **What and where:** one lens run's outcome, sightings and decided check, `ReviewRecords.lens` (`review-records.ts:176-195`), exported by `lensRecords` (`review.ts:3097-3128`) as each lens ends (`review.ts:3223-3265`) and again with its check at the end (`review.ts:3173`).
- **Address:** the run's request key, `run.request` (`review-records.ts:194`; `review.ts:3108`). A run with no request key, from an older Melian, gets no record (`review.ts:3108`).
- **Writers:** the early export and the final export. They write two records under one key with different bytes (`check` is `null` early). Neither replaces the other. The round names only the final one (`review.ts:3220-3222` comment, `3203-3218`).
- **Readers that decide:** `RecordedRound` counts its sightings and its `check` (`recorded-round.ts:165-171`), and refuses a producer's record with no check (`recorded-round.ts:168-169`).
- **Kind:** shared slot. The sightings come from the same findings-document slot as D4, keyed by `lensSource(name, version, level)` (`review.ts:3109`, `3118`), not from the run named by the key.
- **Wrong answer:** two runs of one lens, version and level, under different requests, at one revision, write one slot. The record of either carries whatever the slot holds. Whether a stale lens run can write that slot after a newer run decided was not checked here.
- **Guards:** `owned` on the final export (`review.ts:3706`). The early export has no `owned` check (`review.ts:3223-3265`), but no round names its records.
- **Covered by:** none found for the lens slot.
- **Wrong answer:** none found. Row B7 shows that a replaced run cannot write the slot, since `report_finding` checks the review index in its own commit (`lens-tools.ts:1593-1604`), and a new lens task clears the slot of every lens it asks.

#### D6. Verification record, producer `verification`
- **What and where:** each claim's verdict and each candidate's outcome, `ReviewRecords.verification` (`review-records.ts:198-218`), built at `review.ts:3706-3721`.
- **Address:** the verification request's key, `verified.key` (`review.ts:3712`).
- **Writers:** the final export only, under `owned`. Same rule as D4: a repeat under one key with other claims adds a record.
- **Readers that decide:** `RecordedRound` takes the claims as verdicts (`recorded-round.ts:172-176`).
- **Kind:** shared slot, judged reuse (rule: the verdict written last).
  - The claims are read from the findings document, not from the verification task's result: `verificationClaims` (`findings.ts:747-767`).
  - For each sighting it takes `Object.values(verifications[revision][producer]).at(-1)` (`findings.ts:761`). That map is keyed by verifier version, and `upsertVerification` moves the version it writes to the end (`findings.ts:979-985`). So the claim is the verdict written last, by whichever verifier version wrote it, not the one this verification's request produced.
  - `dismissals` is always `[]` (`review.ts:3714`), and `matches` is stripped from each claim (`findings.ts:763`), so the record never says the verifier was shown a dismissed finding.
- **Wrong answer:** the record carries what the host's slot holds (row C3), not what this verification's task returned. If two verifier versions' verdicts could stand in one claim's map, the record would carry the one written last under this request's key, and a reader could drop a finding. Row C3 explains why the guards look to make that unreachable. Two smaller gaps are real: the record leaves out `dismissals` and `matches`, so a reader cannot see that the verifier was shown a dismissed finding.
- **Guards:** `owned` (D16).
- **Covered by:** none found.
- **Not verified:** as for row C3. The host's adjudication reads the same last-written verdict (`findings.ts:888-905`), so the record and the host agree.

#### D7. Walkthrough record, producer `walkthrough`
- **What and where:** the walkthrough a round carries, `ReviewRecords.walkthrough` (`review-records.ts:221-231`), from `exportedWalkthrough` (`pipeline/src/summarize.ts:161-177`).
- **Address:** the summary task's input key (`summarize.ts:170-171`).
- **Writers:** the final export (`review.ts:3748-3752`).
- **Readers that decide:** none decides a verdict; a round names it beside its read list (`record.ts:171-175`).
- **Kind:** shared slot. The text is read from `VerdictDocument.routedWalkthroughs[revision][route]` (`summarize.ts:173-174`), a slot by revision and route, not by request key.
- **Wrong answer:** a walkthrough from another task on the same route could carry the indexed task's key. It decides nothing, so nothing fails open or closed.
- **Guards:** the indexed task must be completed, keyed, and its slot's text must equal the published walkthrough (`summarize.ts:167-176`).
- **Covered by:** [issue #443](https://github.com/melian-agent/melian/issues/443), per the identity guideline's walkthrough row.

#### D8. Account record and its key, producer `account`
- **What and where:** how a round accounts for its tier, `ReviewRecords.account` (`review-records.ts:279-325`), built at `review.ts:3193-3200`.
- **Address:** `accountKey` = `KeyedRequest.of("account", { revision, records, resolutionPolicy })` (`review-records.ts:392-397`). `checks`, `filled`, `allowSkip` and `producers` are left out, by the identity guideline's reasoning that they follow from the records and the base's policy (`docs/guidelines/identity.md:67`).
- **Writers:** the final export only.
- **Readers that decide:** `RecordedRound` recomputes the key from the payload's `records` and `resolutionPolicy` and compares it (`recorded-round.ts:148-149`), then uses `checks` as the manifest and `allowSkip` as given (`recorded-round.ts:112-118`). It refuses a version-1 account (`recorded-round.ts:143-144`) and an account whose policy fingerprint is null or differs from the reader's (`recorded-round.ts:100-111`).
- **Kind:** thin key. The verdict depends on `checks` and `allowSkip`, which the key leaves out. The exclusion is written down, but its reason holds only if a reader re-derives them, and none does: `TierAccount.refusal`, which compares an account with the tier (`core/src/tier-account.ts:139-146`), has no caller.
- **Wrong answer:** an account that names the right records and policy but a longer `allowSkip`, or a `checks` list missing a check, passes in `RecordedRound` a round that skipped or never ran that check. Melian's own export does not write such an account. It needs someone who can add records: a writer with store access today, or a writer's head job once the relay hands over `account` records, which rule 6 allows (`record.ts:59-68`). **Fails open**, for a planted or relayed account only.
- **Guards:** the key comparison; the policy fingerprint comparison ([issue #502](https://github.com/melian-agent/melian/issues/502), closed); `trust.writers: true` before any record counts (`commands.ts:805-806`).
- **Covered by:** [issue #395](https://github.com/melian-agent/melian/issues/395), whose gate is meant to compare the account with the base tip's tier (`tier-account.ts:66-69` says so).

#### D9. Round record and its key, producer `round`
- **What and where:** a round's manifest, `ReviewRecords.round` (`review-records.ts:332-348`), written at `review.ts:3206-3218`.
- **Address:** `KeyedRequest.of("round", { revision, read })`, the IDs it read in ID order (`review-records.ts:346`). Walkthrough, `replaces` and `before` are left out.
- **Writers:** the final export. Two rounds that read the same records but name another walkthrough share a key and both stand. That is harmless.
- **Readers that decide:** `RecordedRound` (`recorded-round.ts:135-188`); `RecordSet.missing` (`record.ts:460-475`).
- **Kind:** sound key. The reader has a gap: `missing` matches a named record by ID, kind, key and changeset, not revision (`record.ts:466-473`), and `piecesOf` never checks a named record's revision (`recorded-round.ts:159-177`). So a round at one revision can count check, lens and verification records of another revision of the same changeset.
- **Wrong answer:** a round at a new head that names an earlier head's clean check record reads as passed. Melian's own export builds every record at its own revision (`review-records.ts:380-385`), so only a planted or relayed round does this. **Fails open**, for a planted or relayed round only. The relay check refuses a record of another revision (`record.ts:348-349`), but a round names records already in the store by ID, which that check does not reach.
- **Guards:** the account's key holds the round's revision (`recorded-round.ts:148`); the account must name exactly the round's other records (`recorded-round.ts:146-149`).
- **Covered by:** none found. [Issue #395](https://github.com/melian-agent/melian/issues/395) builds the reader that would need it.

#### D10. Triage, telemetry and dismissal records
- **What and where:** `ReviewRecords.triage` (`review-records.ts:234-261`), `telemetry` (`review-records.ts:264-271`), `dismissal` (`review-records.ts:351-378`).
- **Address:** triage by its request key; telemetry by the round record's ID; dismissal by the finding ID alone, with no revision (`review-records.ts:375`, `record.ts:253`).
- **Writers:** none in production. A static finding's dismissal throws `unprovenRun` (`review-records.ts:354-359`).
- **Readers that decide:** none.
- **Kind:** sound, unused.
- **Wrong answer:** none today.
- **Covered by:** [pull request #557](https://github.com/melian-agent/melian/pull/557) shares a static dismissal under its stamp.

#### D11. Kinds with no payload check: `marker`, `post`, `status`, `ledger-comment`, `comparison`
- **What and where:** kinds the envelope accepts (`record.ts:46-56`, `71`) for which `reviewPayloads` has no check (`record-payloads.ts:353-410`).
- **Address:** as D2.
- **Writers:** none in production.
- **Readers that decide:** `RecordSet.of` throws `unvalidatedKind` for a counted record of such a kind (`record.ts:279-281`, `408`), and `RecordedRound.of` turns that into not reviewed for every round of the changeset (`recorded-round.ts:73-78`).
- **Kind:** sound.
- **Wrong answer:** one such record in a changeset makes all its rounds read not reviewed. **Fails closed.**
- **Covered by:** later builds of step 46.

#### D12. Cell and cell version
- **What and where:** one compare-and-set cell per changeset. Memory: `record-store.ts:140-147`. Directory: `directory-record-store.ts:109-120`, `132-147`, `210-217`. Git: `git-record-store.ts:181-200`.
- **Address:** the changeset. The version is a random UUID in memory and git, and a number never reused in a directory.
- **Writers:** none in production; the only callers are the conformance suite (`core/src/testing.ts:166-372`) and `dispose`.
- **Readers that decide:** none in production.
- **Kind:** sound, unused.
- **Wrong answer:** none found.
- **Guards:** the conformance suite, including a value that went away and came back (`testing.ts:233-246`).

#### D13. Publication lease
- **What and where:** `Lease`, `core/src/lease.ts:47-135`.
- **Address:** held in the cell; a write is admitted by incarnation and generation together (`lease.ts:122-124`).
- **Writers:** none: `Lease.take` and `Lease.parse` have no caller outside core.
- **Kind:** sound, unused. The generation rises by one per taking (`lease.ts:80`); it is a counter, not a hand version.
- **Wrong answer:** none today.

#### D14. Record and payload versions
- **What and where:** the envelope's `v: 1` (`record.ts:239`), each payload's `v: 1`, the account's `v: 2` with a legacy `v: 1` (`record-payloads.ts:292-302`), and the fingerprint's version prefix (`pipeline/src/configurations.ts:18-19`).
- **Address:** not a key; a schema version a reader branches on.
- **Writers:** set by hand in source.
- **Readers that decide:** the payload checks refuse other versions (`record-payloads.ts:349-352`); `RecordedRound` refuses an account at `v: 1` (`recorded-round.ts:143-144`) and compares fingerprints with their prefix (`recorded-round.ts:106`).
- **Kind:** hand version.
- **Wrong answer:** a version not raised when a payload's meaning changes would let an old reader read a new record as the old shape. No case found. A version raised needlessly reads as not reviewed. **Fails closed** in every case read.
- **Guards:** strict schemas, `additionalProperties: false` (`record-payloads.ts:10`).
- **Covered by:** [issue #437](https://github.com/melian-agent/melian/issues/437) for hand versions generally.

Row D15, the export's reading of `writesFixedText`, is row A5.

#### D16. `owned`, the export's ownership test
- **What and where:** `review.ts:3699-3706`.
- **Address:** the revision's decision in `VerdictDocument`, compared by adjudication task and findings version.
- **Writers:** adjudication writes the decision; every sighting writer bumps the findings version.
- **Readers that decide:** whether this review exports any record at all.
- **Kind:** judged reuse (rule: `owned`). It inspects stored state to decide whether the records it is about to build are the ones adjudication read.
- **Wrong answer:** it cannot tell a slot overwritten before adjudication from one written by the run it names, so it does not catch D4's sequence. When it fails, no records are exported and the record holds no round. **Fails closed.**
- **Guards:** none beyond itself.
- **Covered by:** none needed for its own failure.

#### D17. Judgement key, `keyOf` in `StateTree.read`
- **What and where:** `state-git/src/state-tree.ts:57-59`, used at `state-tree.ts:145-150`.
- **Address:** every field `ls-tree` lists, the path as raw bytes.
- **Writers:** one handle's in-memory map (`git-record-store.ts:61`). Never stored.
- **Kind:** sound.
- **Wrong answer:** none found.

#### D18. Leftover owner, `Owner`
- **What and where:** `state-git/src/owner.ts:15-71`.
- **Address:** 16 hex digits of SHA-256 of the host name and, on Linux, the pid namespace's device and inode (`owner.ts:15-25`), and the pid.
- **Writers:** the name of each leftover a call makes (`owner.ts:56-58`).
- **Readers that decide:** the sweep removes a leftover whose owner is here and gone (`owner.ts:61-70`).
- **Kind:** thin key, marked: the identity guideline records that two Linux machines with one host name can match (`docs/guidelines/identity.md:104`).
- **Wrong answer:** in an unsupported shared state directory, a live call's temporary files are swept. Pid reuse keeps a leftover. Neither touches a record.
- **Guards:** removal only of entries this user owns, by the guideline.

#### D19. Host facts, `hostFacts`
- **What and where:** `core/src/host.ts:20-42`, called by the check request with no argument (`checks.ts:710`).
- **Address:** platform, architecture, Node version, and whether the filesystem under the system's temporary directory folds case.
- **Writers:** computed per process; `caseFolds` is cached per directory (`host.ts:17`, `31-32`).
- **Readers that decide:** part of the check request key (`check-request.ts:121-136`).
- **Kind:** thin key, marked by the guideline's exclusions for the operating system release and CPU model.
- **Wrong answer:** none found.
- **Not verified:** whether the check runs on a filesystem whose case folding matches the temporary directory's. `checks.ts:710` asks `tmpdir()`; the static worktree is added at a root not traced here (`pipeline/src/static.ts:234`).

## The four questions the issue also asks

### Do the relay and the gate reach past the record format into how a record was produced?

Neither is built at this head.

- The relay of [issue #397](https://github.com/melian-agent/melian/issues/397) does not exist. Its rule check, `SharedRecord.refusedFromHeadCode` (`core/src/record.ts:341-351`), has no caller. The `melian round` workflow keeps its store in `$RUNNER_TEMP/state` (`.github/workflows/melian-round.yml:307-308`) and adds no record anywhere.
- The gate of [issue #395](https://github.com/melian-agent/melian/issues/395) does not exist. There is no `melian gate` command. `RecordSet.standingRounds` (`core/src/record.ts:429-435`) and `TierAccount.refusal` (`core/src/tier-account.ts:139-146`) have no caller outside core. The merge-group check still copies the head's status (`cli/src/merge-group.ts`), as `docs/design.md` says.
- What exists: `exportRound` writes a review's records when `melian review` is given `--records dir:<path>` and the base sets `trust.writers: true` (`review.ts:3133-3219`, `cli/src/commands.ts:275-279`, `320-325`). One reader, `RecordedRound` (`recorded-round.ts:58-123`), decides a round from its records. Only `melian findings --records` calls it (`cli/src/commands.ts:786-847`). No review reads records back to seed itself.
- Of the record builders, check, lens, verification, walkthrough, account and round have a production caller. Triage, telemetry and dismissal do not (`review-records.ts:234`, `264`, `351`).

So the answer is no in the code. What exists reads only record fields. `refusedFromHeadCode` reads kind, changeset and revision. `RecordedRound` reads a round, its account and the records it names by ID, checks their payloads, and adjudicates under the reader's own policy fingerprint. It opens no local store.

But the answer is yes in meaning. A record's payload claims more about how it was made than it can show, and a reader that trusts the format inherits these facts about the local store:

1. **A check record's sightings are a slot, not the run's output.** They are read from the findings document's slot for that check and tool version at that revision (`findings.ts:167-178`, through `review.ts:3144-3146`). The record's key names the run the review held (`review.ts:3148`). Nothing ties the two. A reader's answer rests on row A1 and on the check run reuse in row A2 (`checks.ts:801-804`).
2. **A lens record's sightings are the same kind of slot**, keyed by `lensSource` (`review.ts:3109`, `3118`). It rests on row B7, which is fenced.
3. **A verification record's claims are the verdict last written** for each sighting, by any verifier version (`findings.ts:761`, `979-985`). It rests on row C3.
4. **`withheld` rests on a proof the record does not carry.** Whether a static check's sightings were shared is decided by `proven` on the exporting host (`review.ts:3149-3161`), from a request the record does not hold. A reader cannot check it again. It rests on `ranInThisProcess` (`checks.ts:76-81`) and on the hand versions in rows A4 and A5.
5. **`request: null` is honest.** A record from a review given bare check records says so, and no request lookup matches it (`review.ts:3148`).

The account and the policy fingerprint are format only: the reader computes the account's key again (`recorded-round.ts:148`) and compares the fingerprint with its own (`recorded-round.ts:106`). But it takes the account's `checks` and `allowSkip` as given (row D8), and it does not check a named record's revision (row D9). Today that decides only what `melian findings --records` prints. Once the gate reads records, it decides a merge.

### What `ReviewRecords` proves because the local store cannot

Each proof the export carries today, and the weakness of the local store it makes up for:

| Proof | Where | The local weakness it covers |
| --- | --- | --- |
| Refuses a check run handed in for another base, head or tier, `foreignCheckRun` | `review.ts:2394-2406` | A `CheckRun` is a plain object, and the store does not bind a run to a review. |
| Writes `request: null` for a review given bare check records | `review.ts:3148` | Bare records name no request, so nothing says what produced them. |
| Exports a static check with sightings as `failed` and `withheld` unless `runChecks` returned its run in this process and the run's request asks for check code that stores no tool text | `review.ts:3149-3161`, `checks.ts:76-81`, `check-request.ts:93-99` | The findings slot does not say which run wrote it (row A1), and an older build stored tool text there. |
| Withholds an Enola snapshot whose identities are not hashes | `review-records.ts:165-168`, `472-476` | The check run record holds text the head or Enola wrote. |
| Rewrites text: reasons and errors become codes or `withheld`; tool versions only in semver form; caveats only the two fixed sentences; static messages and explanations replaced; Enola receipts cut to three fields | `review-records.ts:120-132`, `441-470`, `506-536`, `538-573` | The local store keeps text a tool, a provider or the head wrote. |
| Exports only when this review's adjudication is the revision's decision and the findings version is unchanged, `owned` | `review.ts:3699-3706` | A later review can replace this review's sightings in the shared findings slot. It does not catch row A1's sequence, since the slot was emptied before adjudication read it. |
| Exports the walkthrough only from a completed, keyed task whose stored text equals the published one | `summarize.ts:161-177` | The walkthrough is stored by revision and route, not by request (row B15). |
| Fills, in the account, each check no record covers, and joins producers withheld alike | `review.ts:3176-3200`, `review-records.ts:287-321` | A host's check records leave out the skips and failures adjudication inferred. |
| Refuses a static finding's dismissal, `unprovenRun` | `review-records.ts:353-359` | No sighting carries the run that wrote it. The dismissal builder has no caller yet. |
| Names the previous revision's rounds from the store, and replaces none | `review.ts:3201-3214` | No local record says which rounds stood before. |

What it would take for the record to be written where the result is produced, from what the code shows:

- **The producer would need its own output, not a slot.** The check task writes its sightings into the shared findings slot and its record into `ChecksDocument` in one commit (`checks.ts:468-477`). A record built there would hold that run's own findings, and row A1's sequence could not reach it. The lens and verification records read the findings document in the same way (`review.ts:3118`, `findings.ts:747-767`), so they would need the same change.
- **The producer would need the request it was keyed by.** `runChecks` keys one value (`checks.ts:714`) and builds the task's input beside it (`checks.ts:778-787`). A resumed task reads host facts and the install again ([issue #459](https://github.com/melian-agent/melian/issues/459)). [Pull request #557](https://github.com/melian-agent/melian/pull/557) stores the whole request in `ChecksDocument` version 5, which would give the task the value its key hashes.
- **The text rewriting would move with it**, since the record would leave the producer's commit, not the review's.
- **The write would need to survive a crash.** A Pi Durable commit covers its own storage, not the record store. A producer would have to keep the record durably and add it afterwards. `add` may be repeated (`core/src/record-store.ts:11-12`), which makes that safe.
- **The account and the round would stay the review's.** They say what a round read, which only the review knows. They would name results by request key instead of carrying copies of slots.

How much of this the producers already allow was not traced beyond the rows above.

### Open pull requests that add, change or fix a row

Read from each open pull request's title, description and changed files on 2026-11-18. None is merged.

| Pull request | What it does to the rows |
| --- | --- |
| [#557](https://github.com/melian-agent/melian/pull/557), share a static sighting only when its run's stamp proves it | **Fixes A1 and D4 on the export side only**, for [issue #528](https://github.com/melian-agent/melian/issues/528). It stamps the run's request key beside the sightings it wrote, in the findings document version 12, and stores each run's whole request in `ChecksDocument` version 5 (rows A2, A8, C22). It replaces the `ranInThisProcess` proof in A5 with `StaticProof`, and lets a static dismissal be shared (D10). The host's own verdict keeps A1's gap, as [issue #562](https://github.com/melian-agent/melian/issues/562) says. |
| [#551](https://github.com/melian-agent/melian/pull/551), refuse free text in a shared record's classed fields on read | **Changes D11 and D14**, for [issue #548](https://github.com/melian-agent/melian/issues/548). Every ID, hash, version, time and code field in a record payload gets a pattern, so a reader refuses a record Melian never built. It adds a guard; it adds no row. |
| [#566](https://github.com/melian-agent/melian/pull/566), export a round's triage record | **Adds a writer to D10**, for [issue #554](https://github.com/melian-agent/melian/issues/554): the triage record gets a production caller, and the round names it. It moves lens selection into one function the reader and the review share. |
| [#536](https://github.com/melian-agent/melian/pull/536), let a fallback model run at its own thinking level | **Changes B3, B11, B15 and B16**: the route's per-model level enters the lens, verification, walkthrough and triage requests. It raises the lens task to version 9 on top of #532 (B1, a hand version). It also changes `recorded-round.ts` and `review-records.ts` (D4 to D9); what it changes there was not read. |
| [#532](https://github.com/melian-agent/melian/pull/532), count an attack answered only by a probe that shows something | **Changes B6 and B10**: `probeConclusive` and `probeFailed` change, so `runStands` and the probe rerun rule judge stored probes by a new test. It raises the lens task's version (B1). |
| [#567](https://github.com/melian-agent/melian/pull/567), treat Enola policy files with a newline in their name as policy | **Uses A4 as designed**: it raises `checkVersions["static.enola"]` from 3 to 4 so stored runs are not reused. It is an example of the hand version doing its job, and of how easily it could be missed. |
| [#550](https://github.com/melian-agent/melian/pull/550), measure a past miss with the whole review | **Changes B18**: it adds a field, `shadowsBuiltin`, that the lens `version` leaves out (`core/src/lens.ts` in its diff). The identity table's lens version row would need it. |
| [#515](https://github.com/melian-agent/melian/pull/515), run probes in the `melian round` workflow | Touches `probe.ts` and `review.ts`. Whether it changes a key was not verified; its description names none. |
| [#314](https://github.com/melian-agent/melian/pull/314), keep a pull request's storage on the state branch | **Would add rows**: a `ChangesetStore` and a state-branch copy of each pull request's storage. Last updated 2026-11-12, before [the shared record decision](../decisions/2026-11-13-shared-record-behind-a-store-port.md) replaced that design. |
| [#216](https://github.com/melian-agent/melian/pull/216), [#218](https://github.com/melian-agent/melian/pull/218), [#220](https://github.com/melian-agent/melian/pull/220), the coverage ledger and delta rounds | **Would add rows**: a coverage record per round, sightings carried under a `carried/` producer, and a repeat review that attaches to the round that decided it. Last updated in October and early November 2026. |
| [#571](https://github.com/melian-agent/melian/pull/571), [#563](https://github.com/melian-agent/melian/pull/563), [#508](https://github.com/melian-agent/melian/pull/508), [#209](https://github.com/melian-agent/melian/pull/209) | Change no source in the five packages. |

Open issues the brief named, and the rows they would touch:

- [Issue #562](https://github.com/melian-agent/melian/issues/562) fixes A1, A7 and D4 on the host.
- [Issue #531](https://github.com/melian-agent/melian/issues/531) fixes B3, B6 and B10 for files a probe may read outside the checkout.
- [Issue #437](https://github.com/melian-agent/melian/issues/437) covers A3, A4, A5, A12, B3, B11 and B16. It does not name adjudication (C8).
- [Issue #481](https://github.com/melian-agent/melian/issues/481) would give D10's dismissal record a writer, and would make C5's carry rule a shared fact. It does not change that rule.
- [Issue #475](https://github.com/melian-agent/melian/issues/475) would make records an input to a review. Every row in section D would then decide what runs, not only what a reader prints.
- [Issue #554](https://github.com/melian-agent/melian/issues/554) is pull request #566.

### Count by kind, and the rows that fail open

78 rows. A row counts once under each kind it has, so the kinds add to more than 78.

| Kind | Rows | Count |
| --- | --- | --- |
| Sound | A2, A9, A10, A13, A15 to A21, B1, B2, B8, B9, B12, B14, B16, B17, B18, C4, C9, C10, C13, C15, C17 to C21, D1, D2, D3, D10 to D13, D17 | 38 |
| Sound and nothing else | A9, A10, A15 to A21, B8, B9, B12, B14, B17, B18, C4, C10, C13, C15, C18, C19, C21, D1, D2, D3, D10 to D13, D17 | 30 |
| Shared slot | A1, A6, A11, A14, B4, B7, B10, B11, B15, C3, C7, C8, C12, C14, C16, C20, D4, D5, D6, D7 | 20 |
| Judged reuse | A7, A11, B5, B6, B10, B11, B13, B15, C5, C6, C11, C17, D6, D16 | 14 |
| Thin key | A2, A3, A11, B2, B3, B5, B6, B10, B11, B15, B16, B19, C8, C12, D4, D8, D18, D19 | 18 |
| Hand version | A4, A5, A8, A11, A12, A13, A14, B1, B4, B11, B13, B16, C8, C9, C22, D4, D14 | 17 |
| Reader gap | D9 | 1 |

19 rows fail open. They are ranked here by what it takes to reach them and how much rests on them. Each says whether an issue covers it.

The host's own verdict, with no one acting in bad faith:

1. **A1, with A7 and D4.** A stale static check run empties a newer run's blocking finding in the shared findings slot. The newer run's task is reused, adjudication reads the empty slot, and the review passes. The export then writes a `ran` record with no sightings. Covered by [issue #562](https://github.com/melian-agent/melian/issues/562); [pull request #557](https://github.com/melian-agent/melian/pull/557) covers only the export.
2. **C8.** The adjudication attach key holds the task's input but not the code that decides from it. After a release that makes adjudication block more, a repeat review of an unchanged head attaches to the old task and prints the old pass. No issue found; [issue #437](https://github.com/melian-agent/melian/issues/437) does not name adjudication.
3. **B3, with B6.** A finished lens run, probing runs included, is copied when an input its key leaves out has changed: files under `probe.read`, the installed dependencies of the code under test, the lens tools' code and the code that handles the answer, and the packages beneath Pi. Covered by [issue #531](https://github.com/melian-agent/melian/issues/531), [issue #437](https://github.com/melian-agent/melian/issues/437) and [issue #470](https://github.com/melian-agent/melian/issues/470). The installs are out of the key by the maintainer's ruling of 2026-11-16, recorded in the identity guideline.
4. **C5.** A dismissal holds while its trigger is unchanged, whatever the finding's severity. A finding dismissed at P3 that returns with the same ID and trigger at P0 stays dismissed. This matches the documented rule, "until its trigger changes materially". No issue found.
5. **B11.** The verification key leaves out the code that handles the verifier's answer, so a fix there does not ask again, and an old refutation stands on a repeat review. Covered by [issue #437](https://github.com/melian-agent/melian/issues/437).
6. **B10.** A stored probe rerun that ran clean stands for its probe on later reviews, whatever changed in the files it may read or the install. The claim then reads "not reproduced", and the finding can be refuted. Covered in part by [issue #531](https://github.com/melian-agent/melian/issues/531); the install is out by the same ruling.
7. **A3.** The check request key leaves out what a run resumed after a crash actually ran with ([issue #459](https://github.com/melian-agent/melian/issues/459)), `PATH`, `HOME` and `TMPDIR` under mutation ([issue #458](https://github.com/melian-agent/melian/issues/458)), and a Bun install, which still counts as identified (no issue found).
8. **A4 and A12.** Hand-raised versions of Melian's own check code and of mutation test selection. Code that changes without its number reuses runs of the old code. Covered by [issue #437](https://github.com/melian-agent/melian/issues/437).
9. **B16.** Triage's key leaves out the code that maps a decision to a level. A fix there reuses old decisions, within the band policy allows. Covered by [issue #437](https://github.com/melian-agent/melian/issues/437).

Text leaving the host:

10. **A5.** Whether a static check's sightings may leave the host is a comparison of hand-raised numbers. A build that stores tool text again, without raising its number, would share it. The export's rewriting of static messages and explanations (`review-records.ts:441-450`) limits what could leak. Covered by [issue #437](https://github.com/melian-agent/melian/issues/437); [pull request #557](https://github.com/melian-agent/melian/pull/557) changes the proof.

Only someone who can write the store:

11. **D8.** A reader takes an account's `checks` and `allowSkip` as given, so a planted or relayed account can skip a check. Covered by [issue #395](https://github.com/melian-agent/melian/issues/395), whose gate is meant to compare the account with the tier.
12. **D9.** A reader never checks a named record's revision, so a planted or relayed round at a new head can count an earlier head's clean records. No issue found.
13. **A13.** A self-consistent Enola graph planted in the state directory drops Enola findings. That includes one written by a trusted head's tests under mutation, which run unconfined. No issue found; it is the "whoever can write the store can plant a result" limit issue #568 asks the model to state.

Accepted by a decision or by design:

14. **C6.** An inherited dismissal rests on the verifier answering "same", fenced by severity and the trust floor, as [the decision](../decisions/2026-11-08-dismissal-carries-to-restatement.md) accepts.
15. **B5.** A repeat review attaches to lens runs that were shown no callers when this review has a graph, because callers are keyed `bestEffort` on purpose.

## A key in the code and not in the table

Each of these decides reuse, attachment, sameness or trust, and the identity guideline's table has no row for it, or a row that misses what it decides.

Checks and caches:

- **Mutation authority**, `owners[revision]` and `ownsMutation` (`checks.ts:98-99`, `364-368`, `816-834`). It decides whether a mutation task may run the head's tests and write its findings.
- **`fixedTextSince` and `writesFixedText`** (`check-request.ts:79-98`). They decide whether a static check's sightings may be shared, by comparing hand numbers. The check record row mentions them only in passing.
- **`ranInThisProcess`** (`checks.ts:76-81`), an in-process `WeakSet`. The table leaves out in-process lookups, but this one decides what leaves the host. [Pull request #557](https://github.com/melian-agent/melian/pull/557) removes it.
- **`mutationSelectionVersion`** (`mutation-vitest.ts:84`), a hand version inside `mutationInstallation`. The partition row also omits that its `inputs` hash only Stryker's version (`mutation-static.ts:379-381`), and the partition's own `version: 3` (`mutation-cache.ts:72`).
- **The coverage producer strings** (`coverage-identity.ts:3-4`, `coverage-cache.ts:43-47`). The table's coverage producer index row says nothing is left out; it does not say the producer is a set of hand-written version strings.
- **The review coverage identity** (`callers.ts:197-199`), SHA-256 of the review's nonce and its lens conversation IDs. Random on purpose, so it decides no reuse; but it is a hash the table does not list.
- **The static worktree lock reason** (`static.ts:605`, `631-638`), which decides whether a worktree belongs to a live run.
- **Cache scratch names** (`cache-scratch.ts:16-23`, `59-63`), which decide whether a temporary is swept by its writer's pid.
- **`RunIdentity.policy`** (`checks.ts:74`, `717`) holds the first 16 hex digits of the check request key, not a policy. The table covers it through `identityKey`, but its name misleads.

Lenses, probing and triage:

- **`rerunKey`** (`probing.ts:751-753`), the check, version and probe ID that decide which stored rerun a verifier is shown and whether a probe runs again.
- **The probe rerun task's attach key**, `JSON.stringify(input.probes)` (`review.ts:1609`), not built through `KeyedRequest.of`.
- **`triageQuestionSet.version`** (`core/src/triage.ts:12`), a hand-kept `"1"`. The triage request also holds the questions, so it decides no reuse alone.
- **The fallback decider's version** (`decisions/src/fallback.ts:54-56`), a hash of its fixed text that the triage request holds. It is outside the five packages, but it decides triage reuse.
- **The selection, `selectionOf`** (`review.ts:1684-1686`), decides on its own whether a review attaches to a whole lens task. The table names it only inside the lens request row.

Findings, verdicts and publication:

- **`producerKey`**, `<check>@<version or "">` (`findings.ts:130-132`), the slot key every sighting and verification is stored under. The table lists `lensSource` for lenses, but not the slot itself, which row A1 shows every run of a static check shares.
- **The findings version counter** (`findings.ts:647-663`). It decides whether an adjudication is reused and whether publication refuses a verdict. It is a counter, not a hash.
- **The round ID**, `r<n>` local to a store and `<changeset ID>.r<n>` in public (`rounds.ts:135`, `248`), and `legacyKey` (`rounds.ts:76-78`). They bind publication, run details and comparisons to a round.
- **The marker signature** (`github/src/publication.ts:48-50`), which decides that a post was already made and that an advisory was listed.
- **The adjudication attach key**'s row says only that run details are left out. It does not say that the key is plain `JSON.stringify` in construction order, that the review index holds one entry per revision, or that the deciding code is not in it (row C8).

The shared record:

- **`owned`** (`review.ts:3702-3705`): adjudication task and findings version decide whether a review exports at all.
- **A third claim identity.** `RecordedRound`'s `once` writes `` `${id} ${check}@${version ?? ""}` `` (`recorded-round.ts:190-194`). The table's "one thing with two keys" section lists two forms. This is a third, matching the pipeline's form, not core's.
- **The account's producer key**, `` `${check}@${version ?? ""}` `` (`review-records.ts:292`, `recorded-round.ts:153`), which joins two producers whose versions were withheld alike.
- **The telemetry record's key**, the round record's ID (`review-records.ts:270`), and **the dismissal record's key**, the finding ID alone (`review-records.ts:375`). Neither has a caller yet.
- **Lease admission** by incarnation and generation (`core/src/lease.ts:122-124`). No caller yet.

Pending: [pull request #550](https://github.com/melian-agent/melian/pull/550) adds `shadowsBuiltin` to what the lens `version` leaves out, which the lens version row would need.

## How large the gap is

Of 78 rows, 30 are sound and nothing else. Most of those are infrastructure: the tool cache, scratch names, locks, the record envelope, the publication documents. They decide little on the path from a change to a verdict.

On that path the picture is different. The results themselves are mostly stored soundly: a lens task's outcomes, a check task's records, a prober's probes and the Enola graph each live under their own task or content key and are not replaced. What the verdict reads is not those results. It reads the findings document, keyed by revision and by producer name and version, where every run of a producer writes the same slot. Every sighting, every verification and every dismissal lives there (rows A1, B7, C3, C5). One row in that document, A1, is a slot with no fence. It and C5, the dismissal that ignores severity, are the only fail-open rows found that need nothing unusual: no release, no change outside the key, no crash and no store writer. The lens slot (B7) and the verification slot (C3) are fenced by ownership tests in the write commit, and fail closed on the reading done here.

Three things carry most of the weight:

1. **The findings document as the verdict's input** (A1, A7, B7, C3, C4, C5, D4, D5, D6). It is the place #568's rule 5 says a verdict should not be: a store that results are written into and replaced in. Every shared record of a check, lens or verification is a copy of one of its slots, so the record inherits whatever the slot holds.
2. **Code that no key holds** (A3, A4, A5, A12, B3, B11, B16, C8). Eight of the 16 fail-open rows that need no store writer turn on this, wholly or in part: a release changes what a step does, and the key, built from data, does not move. Three of them, A4, A5 and A12, rely on a person raising a number by hand. Issue #437 covers all but adjudication.
3. **One review index entry per revision** (B4, B5, B6, C8). It fails closed on its own: a second selection evicts the first and costs a rerun. But because only one earlier task is ever named, reuse across reviews has to be a judgement about that one task (`runStands`, `attachable`, `owned`), not a lookup.

None of the fail-open sequences was run. A1's matches the report in [issue #562](https://github.com/melian-agent/melian/issues/562); C8's and C5's were traced in the code only. The verification rows, C3 and D6, read as closed only because of guards whose every path was not traced. Where this audit could not tell, it says so below.

## What this audit could not verify

- **C8:** whether some input of the adjudication task, such as the verifier version in its provenance, always changes between releases in practice, which would close the gap.
- **C3 and D6:** whether any path leaves two verifier versions' verdicts in one claim's map. The clear on start and the ownership fence look to prevent it; not every caller of `upsertVerification` was traced.
- **C22:** what a collision of two hand-raised document versions does to each field. The fields were not enumerated.
- **A3 and D19:** whether the check runs on a filesystem whose case folding matches the system's temporary directory, which `hostFacts` asks.
- **A13:** whether `enola check` reads anything beyond the restored graph files.
- **A14:** whether any consumer of exported records reads the coverage IDs. Only `packages/pipeline` and `packages/core` were searched.
- **B5:** whether adjudication refuses a non-probing lens run attached without `--rerun` when the current plan now refuses its model.
- **B11:** what verifier check record a task gets when some of its candidates failed and others did not.
- **B19:** whether `RecordedDecider` runs outside tests and evals.
- **C12:** whether any committed comparison record mixes round IDs from two clones.
- **C21:** how `canonicalName` spells `HEAD`.
- **D5:** that the early lens export, which has no `owned` test, never feeds a reader; no round names its records, but no reader was traced that might list them.
- **#515 and #536:** what their changes to `review.ts`, `recorded-round.ts` and `review-records.ts` do to the keys; only file lists and descriptions were read.
- **Packages outside the five:** `packages/decisions` was read only where triage reaches it, and `packages/evals` and `packages/pi-extension` not at all.
