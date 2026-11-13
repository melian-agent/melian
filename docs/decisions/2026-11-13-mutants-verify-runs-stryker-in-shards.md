# `melian mutants verify` runs Stryker in sharded Actions jobs, and builders justify only survivors

Amends: [mutation evidence by enumeration and verification](2026-10-24-mutation-evidence-by-enumeration-and-verification.md), section 1's `verify` command, section 3's verification as evidence, section 5's stale kills, section 8's changes to this repository, and what sections 4 and 6 say a timeout is, for how a pull request's kills are proved
Amends: [Stryker leaves this repository's review rounds](2026-10-24-stryker-off-the-hot-path.md), the interim rule, which ends when the job lands
Amends: [a mutation proof runs each claim against its named test alone](2026-11-04-mutation-proof-scope.md), who runs a kill's proof and against which tests

Status: proposed on 2026-11-13 for [issue #240](https://github.com/melian-agent/melian/issues/240), for the maintainer's ruling. Not built. The maintainer reshaped step 34 on 2026-11-10, in the coordinator's session, as [the coordinator recorded on the issue](https://github.com/melian-agent/melian/issues/240#issuecomment-6754427946): Stryker proves the kills, with per-test coverage and an incremental cache seeded from `main`, across a matrix of Blacksmith runners, once on the final head beside the round, and builders justify only survivors. The rules below are this decision's own. Four choices change what blocks a merge or depart from the reshape, so they are set out as options with their costs, under "Choices for the maintainer", and the ruling settles them. An attacking review and Codex's adversarial review of the first revision, `d80c07a`, found two rules that passed unproved kills; revision 2 closes both. Revisions 3 to 5 closed Codex's findings on the later revisions. A stale `success` could outlive a failed rerun, an answer was keyed only on the files its author cites, a change to set-aside files alone passed with no proof, and a moved base tip left a result made under old policy. Revision 6 closed two more: a merge group must have evidence at its own base, and merged shard reports keep test references straight. Revision 7 shards by span groups, since Stryker selects ranges, not single mutants. Revision 8 keeps every reuse decision out of the shards, since a head's Vitest configuration could replace a seed before Stryker read it. The pull request's reports list every finding. Each part is tagged **[Melian's flow]** for the product or **[Building Melian]** for this repository's process.

## Problem

A builder proves each kill by hand: a scratch script applies one mutant, runs its named test, and records the failure. On [pull request #310](https://github.com/melian-agent/melian/pull/310), 689 claims took about 3.5 hours in the builder's session. [The waiver](2026-11-10-final-rerun-waived-until-mutants-verify.md) dropped the final rerun of earlier claims to save that time, so a later change that lets an earlier kill survive now merges unseen.

The two designs on file are both too slow. [The enumeration and verification decision](2026-10-24-mutation-evidence-by-enumeration-and-verification.md) runs each claim in fresh worktrees, with seven shared control runs per test. By its own measurement, that is up to 204 minutes serial for [pull request #168](https://github.com/melian-agent/melian/pull/168)'s 328 mutants. `static.mutation` ran Stryker cold and unsharded on the host, and took 30 minutes to 2 hours a round.

Example: on #310's 689 mutants, a 16-way split of Stryker's per-test runs, each mutant against only the tests that cover it, would aim at about 13 minutes of wall time.

## Decision

### 1. The commands **[Melian's flow]**

Two commands join `melian mutants list` and `sample`. The Actions job of section 2 only calls them, so a customer or a host gets the same proof without Actions.

- `melian mutants verify <range|#pr> [--shard <plan> <k>] [--json] [--out <path>] [--trust-head]` runs Stryker over the changed production lines that `melian mutants list` enumerates, in a checkout of the head. With `--shard`, it runs only shard `k` of the plan in section 2. It writes a shard report: the plan's digest, the head it ran at, each mutant's Stryker status by identity, its covering and killing tests, and the identities of section 3. It runs head code, so it takes the leave `static.mutation` takes: a head a writer pushed to the base repository, or `--trust-head`. Exit codes: `0` when the run finished, whatever its mutants did; `2` when it could not run; `64` for usage.
- `melian mutants verdict <report>... --plan <plan>` reads every shard's report and the accepted answers of section 4, and prints the result. It runs no head code. It exits `0` when every mutant passes, `1` when a survivor has no accepted answer, and `2` when the reports cannot decide, as section 6 says.

Stryker runs under the base's `stryker.config.json` and `vitest.stryker.config.ts`, read from the plan's policy commit through git and written into the run's scratch, never the head's copies. Problem: Stryker reads every option from its configuration file, and `static.mutation` spreads the head's. Example: a head that sets `timeoutMS: 1` turns every covered mutant into a timeout, and `testRunner: "command"` swaps the runner. Melian then sets, over the base's file:

- `coverageAnalysis: perTest`;
- Vitest's `related` selection;
- the `strykerTestNames` plugin, so a test inside a `describe` runs;
- `ignoreStatic: false`, so a module-level mutant runs against the tests that load it;
- `mutate`: the outer span of each of the shard's span groups, `file:line:column-line:column`. A span group is a set of mutants closed under overlap: any mutant whose span overlaps one in the group is in it. Stryker selects every mutation inside a range, so a group's outer span selects exactly its members, and a group is never split.

The head's `vitest.config.ts` still configures Vitest, as it does for the gate.

A file no test relates to, by Vitest's `related` selection, is set aside with the enumerator's own set-aside files, such as signal-sending code and configuration. Every set-aside file is an obligation of the plan, which section 4 answers with an accepted hand proof; the report lists each. Problem: Stryker activates a mutant on the Vitest worker's `globalThis`, and a child process the test spawns reads the active mutant only from an environment variable Stryker's Vitest runner never sets, so a mutant reached only through a spawned `melian` can never be killed. Example: `packages/cli/src/bin.ts` relates to no test, because the CLI suite spawns it.

Stryker's statuses map to three outcomes:

| Stryker status | Outcome |
| --- | --- |
| `Killed` | proved |
| `Timeout` | by choice 2 |
| `Ignored`, when its mutator is in the base's `excludedMutations` | noted |
| every other status: `Survived`, `NoCoverage`, `RuntimeError`, `CompileError`, `Pending`, and `Ignored` for any other reason | survivor |

Whether a mutant is noted comes from its mutator and the base's `excludedMutations`, as the enumerator already decides, never from Stryker's `statusReason`. A mutant a `// Stryker disable` comment hides is a survivor, and the `forged-mutation-kill` guardrail still reports the comment.

### 2. The job **[Building Melian]**

`.github/workflows/melian-mutants.yml` is a `workflow_dispatch` workflow on the default branch, with a `pull_request` input. It builds Melian and every helper script from the default branch's commit, as `melian round` does. It takes only the heads the round's gate takes: a branch of this repository, pushed by a writer, in a pull request into the default branch. It refuses a fork's head, a head a bot pushed, and a stacked pull request. Its jobs:

1. **Pending**, which runs no head code. It runs the gate, records the head SHA the gate admitted, and sets `melian/mutants` to `pending` on that head, as `melian-status-bot`, from the Environment of the report job below. It passes the SHA and the status's ID on as job outputs. It does nothing that can fail between the gate and the status, so a run that fails later always leaves `pending`.
2. **Plan**, which runs no head code and needs the pending job. It enumerates the mutants of the admitted SHA with `melian mutants list "#N" --all --json`, from git alone. It forms the span groups of section 1 and splits the groups into `n` shards balanced by mutant count, so a large file's groups can go to several shards and no mutant goes to two. `n` is the mutant count over 45, rounded up, at most 16. The plan names each shard's mutants, the set-aside files, the admitted head, and the pull request's `base.sha`, the policy commit, at the gate; its digest is the SHA-256 of its canonical JSON. It reads the cache entry of section 3, checks its signature, and leaves out of the shards every span group the entry lets it reuse. A plan with no mutants skips the shards, and the report job decides from the plan alone, its set-aside files included.
3. **Shards**, a matrix of `n` jobs that need the plan, on `blacksmith-4vcpu-ubuntu-2404`. Each checks out the admitted SHA with `persist-credentials: false`, installs it with `npm ci`, runs `melian mutants verify "#N" --shard <plan> <k>`, and uploads its report as an artefact. A shard holds no secret, has `permissions: contents: read`, and has no cache step; whatever its head code writes to the Actions cache carries no signature, so nothing reads it.
4. **Report**, which runs no head code. It runs after the pending job even when the plan or a shard fails or the plan holds no mutants. It downloads the plan and every shard's report, and decides with `melian mutants verdict`. It writes the cache entry of section 3. It sets `melian/mutants` on the head and posts one comment listing every survivor, timeout and set-aside file. The comment and status go out as `melian-status-bot`, from an Environment whose deployment branches are the default branch alone, as the round's do.

It runs once on the final head, after the last fix pass, beside the round that sets `melian/review`. The aim is 15 minutes of wall time for 300 mutants or more. The build's report records each shard's time.

### 3. The cache **[Melian's flow]**

When a cached result matches, Melian does not run that mutant again, and counts the earlier result as this head's.

Reuse happens only in jobs that run no head code. Stryker's own incremental mode is never used: every shard runs Stryker with `--force` and no incremental file. Problem: a shard runs the head's Vitest configuration and tests, so anything a shard reads, a seed included, the head's code can replace before Stryker reads it, and Stryker marks no reused result as reused. Example: a head's `vitest.config.ts` rewrites the staged seed to record `Killed` for every mutant, and the merged report would carry those kills as genuine.

An entry is Melian's own record of one run, never Stryker's report. For each mutant the run killed, it holds the mutant's `identityHash`, the head the kill ran at, and the killing test's file and full name. It also holds the run's installation, policy and Melian identities. The report job alone writes it, from the shards' reports, and signs it with an HMAC key its Environment holds. The plan job checks the signature, applies the rules below, and drops each reusable span group from the shards' work: a group is reused only when every one of its members is. The report job counts the reused kills from the signed entry beside the shards' results. A shard can still write the Actions cache, since its token reaches every step, but nothing unsigned is read. Example: pull request A's tests save an entry keyed to pull request M's head, recording `Killed` for M's mutants; M's plan job finds no valid signature and runs them.

Only these are reused:

- **Kills.** Only `Killed` results are reused; every other status runs again.
- **The same installation.** The lockfile's digest, the Node version, the versions of Stryker and Vitest, and the runner image's name and version each equal the reading run's own.
- **The same policy.** The digest of the effective configuration Stryker ran under: the base's `stryker.config.json` and `vitest.stryker.config.ts`, every file either imports such as `scripts/stryker-test-names.mjs`, the head's `vitest.config.ts`, and the options Melian sets, equal the reading run's own.
- **The same Melian.** The commit of the Melian build that ran, so a later fix to these rules voids every older entry.
- **The heads choice 4 allows.** Each kill records the head it ran at, and a reused kill keeps that head, never the head that reused it. A kill whose test's file and full name are not unique in its file is never reused from another head, since its test cannot be told from the other.

Left out of the key, with reasons: the shard plan, because a result belongs to its mutant; the run's times; and the pull request, which only finds an entry and decides no reuse. An entry's name carries the format version, `melian-mutants-v1`; a change to what it holds is a new version, and older entries are never read.

### 4. Survivors and accepted answers **[Building Melian]**

A builder answers each survivor in one of three ways. A new test kills it on the next run. An equivalence reason says why no test can kill it. Or a hand proof, recorded as a builder's run is today, shows a test killing it where Stryker cannot reach it. A set-aside file is answered by a hand proof for the file, naming its path in place of a mutant. A reason or a hand proof counts only once accepted, by choice 1.

An answer names a mutant by the `identityHash` core already gives an inventory row, or a set-aside file by its path, with the head's tree, `.melian/mutants/` left out, at the head it was written for. When an accepted answer matches a survivor, Melian does not fail the job for it. Any change to the tree outside that directory voids the answer. Problem: an equivalence argument can rest on a callee, a validator or a configuration the answer never names, so a key on the files an answer cites lets a later change make the mutant observable while the answer still passes it. Example: an answer says `>=` and `>` agree because a caller never passes 0; the caller changes, and the cited file does not. The tree is the one key the answer's author cannot leave something out of. It costs a fresh answer after any later change, and the job runs once, on the final head, so that is rare. `.melian/mutants/` is left out because adding the answer would otherwise change the tree it names.

### 5. The status **[Building Melian]**

The report job sets `melian/mutants` on the head it verified:

- `success` only when every obligation the plan lists has its evidence: each mutant proved, noted, or a survivor with an accepted answer, and each set-aside file with an accepted hand proof. A plan with neither mutants nor set-aside files has none, and passes.
- `failure` when a survivor or a set-aside file has no accepted answer. The description counts each.
- `error` when the reports cannot decide.

The pending job sets `pending` straight after the gate, before planning, so a run that dies in planning or in a shard leaves `pending`, never an earlier `success`. Runs of one pull request queue behind one another in a concurrency group, as the round's do. The report publishes only while the status its own pending job set is still the head's latest `melian/mutants`, so a slower earlier run, or a rerun of failed jobs, never overwrites a newer result. The maintainer alone makes the context required, and only once a merge-group step exists. That step may pass a merge group only on evidence for the group's own base and head: a run there, or a kill the cross-head rule of choice 4 would reuse from the reviewed base. Carrying a head's `success` into the group, as `melian/review` does, is not enough, because a later base commit can change what a test reaches. The step is its own decision.

### 6. What decides, and what fails closed **[Melian's flow]**

One rule closes the class three reviews met one instance at a time: `success` needs evidence for every obligation the plan lists, at the plan's head and policy commit, and anything else reads `error` or `failure`. A merge-group check of the context needs evidence at the group's own base, as section 5 says.

`verdict` reads `error`, never a pass, when:

- a shard's report is missing, does not parse, or names another plan, head, installation, policy or Melian build;
- the shards' mutants are not the plan's exactly once each;
- the pull request's head, or its `base.sha`, is not the plan's when the report reads it again before publishing;
- a shard ran Stryker without per-test coverage, since its differ then reuses every result.

### 7. What happens to the decisions it amends

- Enumeration and sampling, section 1 of the 2026-10-24 decision, stand as built in [issue #239](https://github.com/melian-agent/melian/issues/239).
- That decision's `verify`, and its section 3 classifier, are not built. The classifier would have run seven shared control runs per test, in fresh worktrees. Stryker's in-place build is a switched build: every mutant compiles into the file and is switched on at run time. So a test that reads source text cannot tell a mutant from the original, which was that section's main concern. Whether its two-failure rule survives is choice 3.
- Its section 4 probes and section 6 `mutants` check wait for their own step. When built, they run through this decision's runner. What they say a timeout is gives way to choice 2.
- Its section 5 exact-head rule gives way to section 3 and choice 4.
- The 2026-11-04 decision's named test alone gives way to Stryker's per-test coverage: a mutant runs against every test that covers it.
- `static.mutation` keeps every rule of [mutation reruns, as built](2026-10-16-mutation-reruns-later-changes.md), its `provisional` status included, as an opt-in audit. The job is not that check, and its reuse can pass because section 3 says what a match decides.
- The build's pull request retires [the waiver](2026-11-10-final-rerun-waived-until-mutants-verify.md) with a decision of its own. AGENTS.md then drops the hand proof of kills from Briefs and Validation, keeps it for set-aside files, and shrinks a builder's inventory to its survivors' answers.

### 8. Keys

When the build lands, two rows join the pipeline's table in [the identity guideline](../guidelines/identity.md#the-keys-melian-has):

| Key | Built in | When it matches, Melian | Left out, and why |
| --- | --- | --- | --- |
| Mutants cache entry, and its prune | `pipeline/src/mutants-cache.ts` | reuses a kill without running the mutant | The shard plan, since a result belongs to its mutant. Times. The pull request, which only finds an entry |
| Accepted survivor answer | `core/src/mutation-inventory.ts`'s `identityHash`, with the head's tree | does not fail the job for that survivor | `.melian/mutants/`, since adding the answer would change the tree it names |

## Choices for the maintainer

Each changes what blocks a merge, or departs from the reshape of 2026-11-10. The text above holds for every option.

### Choice 1: who accepts a reason or a hand proof, and where it lives

The maintainer gave the coordinator standing authority on 2026-10-17 to dismiss equivalent mutants with reasons and to read policy notices, reporting each, as the coordinator reported on 2026-11-13 for this decision; no decision file records that grant, so the ruling should. Builders and the maintainer post as one login, so the job cannot tell who wrote an answer: acceptance is enforced by where the answer must live and who reads it.

- **A. The coordinator, under that authority, from a file in the head.** Answers live in `.melian/mutants/answers.yaml`, committed in the head, a policy file, so each new answer raises an acknowledge finding. The coordinator reads it and records its acceptance, and the maintainer reads the coordinator's reports. Costs the maintainer nothing per answer. Nothing machine-enforced stops the job reading `success` before anyone has read the answer: an acknowledge finding never fails `melian/review`, and the queue rule is the control.
- **B. The maintainer, from a file in the head.** As A, but the Ready rule has the builder record the maintainer's read before queueing. Narrows the coordinator's standing authority for this job. Costs the maintainer a read of every answer, and has A's gap before the read.
- **C. Either reader, from the default branch.** `verdict` reads answers from the default branch's tip alone, never the head, so an answer counts only once a pull request of its own has merged it; a head-only answer is a survivor awaiting acceptance. The pull request's own tree does not change when the answers land, so the key still matches. The merge is the machine-enforced acceptance, by whoever the ruling names. Costs a second pull request and its review for each batch of answers, and a rerun after it lands.

### Choice 2: what a timeout is

- **A. A kill, as Stryker counts it.** An activated infinite loop is caught, and the report lists every timeout by mutant. A timeout from a slow runner can pass a mutant no test detects.
- **B. A survivor, as the 2026-10-24 decision ruled.** Never passes unproved. Every real timeout needs an accepted answer, which is reading for whoever choice 1 names.

### Choice 3: how many failures prove a kill

- **A. One, as Stryker runs it.** Stryker's dry run is the unmutated control: every covering test passes once before any mutant runs. An honest test that fails by chance under a mutant still records a kill, and section 3 would reuse it at that head.
- **B. Two.** After its run, each shard runs Stryker again over the mutants it killed, cold, and a kill counts only when both runs killed it; a kill that does not repeat is a survivor. Costs a second dry run and a second run of every kill, about double the shard time.

### Choice 4: which heads a cached kill may come from

- **A. The same head only.** A second run at a head reuses every kill from the first. Drops the reshape's seed from `main`. The attacking review found the seed would almost never apply: any changed file Vitest's graph does not track voids it, and every pull request and fix pass adds a progress-log entry.
- **B. Also earlier heads that are ancestors.** A kill proved at `S` is reused at `H` only when `git merge-base --is-ancestor S H` holds, `S` is in the clone, and [the targeted-rerun rule](2026-11-07-targeted-mutant-rerun.md) selects none of it: its killing test file is not on `vitest list --filesOnly --changed S`, its mutated and test files are unchanged in `git diff --name-status S..H`, and that diff holds no file Vitest's graph does not track and no Vitest configuration, `tsconfig`, `package.json` or lockfile. The ancestry check is required: Vitest's `--changed` compares from the merge base, so after a force-push it misses a change the two-dot diff shows, and it lists nothing for a ref it cannot find. Keeps the reshape's seed. It also trusts Vitest's import graph, which misses what a spawned child imports, a gap the targeted-rerun decision gave up too.

## What this gives up

- Runner time: 16 shards of about 13 minutes are about 3.5 runner-hours on 4-vCPU machines per run, double under choice 3B.
- Files reached only through a spawned process keep a hand proof.
- Whatever the chosen options give up, as each says.

## For the attack

Each rule is to be broken as written.

1. A shard runs head code only under `static.mutation`'s leave, and the Actions job admits only the round gate's heads, at the SHA the pending job recorded. A shard holds no secret, has `contents: read` and `persist-credentials: false`, and has no cache step.
2. Stryker runs under the base's configuration with Melian's options over it, on whole span groups, so each mutant runs in exactly one shard. `Killed` proves a mutant; a timeout is choice 2's; a mutant whose mutator is in the base's `excludedMutations` is noted; every other status is a survivor.
3. A cache entry is Melian's own signed record, read and applied only by jobs that run no head code; shards run Stryker cold. Only `Killed` results are reused, under the installation, policy and Melian identities and choice 4's heads, and a span group is reused only whole.
4. An accepted answer matches a survivor by `identityHash`, or a set-aside file by its path, and the head's tree outside `.melian/mutants/`, and it counts only where choice 1 puts it. `success` needs an accepted answer for every survivor and every set-aside file.
5. `verdict` reads `error` whenever the reports do not cover the plan's mutants exactly once, name another plan, head, installation, policy or build, or come from a run without per-test coverage, and whenever the pull request's head or `base.sha` has moved from the plan's.
6. A job that runs no head code sets `melian/mutants` to `pending` straight after the gate, before planning, and a report publishes only while that pending status is the head's latest.
