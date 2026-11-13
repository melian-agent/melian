# `melian mutants verify` runs Stryker in sharded Actions jobs, and builders justify only survivors

Amends: [mutation evidence by enumeration and verification](2026-10-24-mutation-evidence-by-enumeration-and-verification.md), sections 1, 3 and 8 on proving kills; sections 4 and 6 on timeouts; section 6 on who settles an equivalent claim
Amends: [Stryker leaves this repository's review rounds](2026-10-24-stryker-off-the-hot-path.md), the interim rule, which ends when the job lands
Amends: [a mutation proof runs each claim against its named test alone](2026-11-04-mutation-proof-scope.md), who runs a kill's proof and against which tests

Status: proposed on 2026-11-13 for [issue #240](https://github.com/melian-agent/melian/issues/240), and its five choices ruled the same day. Not built; an attacking review of the ruled text comes before the build. The maintainer reshaped step 34 on 2026-11-10, in the coordinator's session, as [the coordinator recorded on the issue](https://github.com/melian-agent/melian/issues/240#issuecomment-6754427946): Stryker proves the kills, with per-test coverage and an incremental cache seeded from `main`, across a matrix of Blacksmith runners, once on the final head beside the round, and builders justify only survivors. The rules below are this decision's own. The maintainer ruled on its five choices on 2026-11-13, in the coordinator's session, as the coordinator relayed. The section "The maintainer's rulings" records each. An attacking review, eight passes of Codex's adversarial review and three Melian rounds have each found rules that could pass an unproved kill or leave a stale status, and this revision closes every finding so far. The pull request's reports list each finding and the commit that closed it. Each part is tagged **[Melian's flow]** for the product or **[Building Melian]** for this repository's process.

## Problem

A builder proves each kill by hand: a scratch script applies one mutant, runs its named test, and records the failure. On [pull request #310](https://github.com/melian-agent/melian/pull/310), 689 claims took about 3.5 hours in the builder's session. [The waiver](2026-11-10-final-rerun-waived-until-mutants-verify.md) dropped the final rerun of earlier claims to save that time, so a later change that lets an earlier kill survive now merges unseen.

The two designs on file are both too slow. [The enumeration and verification decision](2026-10-24-mutation-evidence-by-enumeration-and-verification.md) runs each claim in fresh worktrees, with seven shared control runs per test. By its own measurement, that is up to 204 minutes serial for [pull request #168](https://github.com/melian-agent/melian/pull/168)'s 328 mutants. `static.mutation` ran Stryker cold and unsharded on the host, and took 30 minutes to 2 hours a round.

Example: on [pull request #310](https://github.com/melian-agent/melian/pull/310)'s 689 mutants, a 16-way split of Stryker's per-test runs, each mutant against only the tests that cover it, would aim at about 13 minutes of wall time.

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

A file no test relates to, by Vitest's `related` selection, is set aside with the enumerator's own set-aside files, such as signal-sending code and configuration. Every set-aside file is an obligation of the plan, which section 4 answers; the report lists each. Problem: Stryker activates a mutant on the Vitest worker's `globalThis`, and a child process the test spawns reads the active mutant only from an environment variable Stryker's Vitest runner never sets, so a mutant reached only through a spawned `melian` can never be killed. Example: `packages/cli/src/bin.ts` relates to no test, because the CLI suite spawns it.

Stryker's statuses map to three outcomes:

| Stryker status | Outcome |
| --- | --- |
| `Killed` | proved |
| `Timeout` | proved |
| `Ignored`, when its mutator is in the base's `excludedMutations` | noted |
| every other status: `Survived`, `NoCoverage`, `RuntimeError`, `CompileError`, `Pending`, and `Ignored` for any other reason | survivor |

Whether a mutant is noted comes from its mutator and the base's `excludedMutations`, as the enumerator already decides, never from Stryker's `statusReason`. A mutant a `// Stryker disable` comment hides is a survivor, and the `forged-mutation-kill` guardrail still reports the comment.

### 2. The job **[Building Melian]**

`.github/workflows/melian-mutants.yml` is a `workflow_dispatch` workflow on the default branch, with a `pull_request` input. It builds Melian and every helper script from the default branch's commit, as `melian round` does. It takes only the heads the round's gate takes: a branch of this repository, pushed by a writer, in a pull request into the default branch. It refuses a fork's head, a head a bot pushed, and a stacked pull request. Its jobs:

1. **Pending**, which runs no head code. It runs the gate, records the head SHA the gate admitted, and sets `melian/mutants` to `pending` on that head, as `melian-status-bot`, from the Environment of the report job below. It passes the SHA and the status's ID on as job outputs. It does nothing that can fail between the gate and the status, so a run that fails later always leaves `pending`.
2. **Plan**, which runs no head code and needs the pending job. It enumerates the mutants with `melian mutants list <base.sha>...<head SHA> --all --json`, naming the pending job's recorded SHAs and never `#N` again, from git alone. The inventory's range records the merge base of those two, which differs from `base.sha` whenever the branch lags `main`, so the plan records three values: `base.sha` as the policy commit, the merge base the inventory enumerated from, and the head. It refuses an inventory whose head is not the recorded head or whose base is not that merge base. Problem: `#N` resolves the pull request's current head, so a push between the gate and the plan, undone before the report, would make the plan describe other code under the admitted head's name. It forms the span groups of section 1 and splits the groups into `n` shards balanced by mutant count, so a large file's groups can go to several shards and no mutant goes to two. `n` is the mutant count over 45, rounded up, at most 16. The plan names each shard's mutants, the set-aside files, the admitted head, and the pull request's `base.sha`, the policy commit, at the gate; its digest is the SHA-256 of its canonical JSON. It reads the cache entry of section 3, checks its signature, and leaves out of the shards every span group the entry lets it reuse. A plan with no mutants skips the shards, and the report job decides from the plan alone, its set-aside files included.
3. **Shards**, a matrix of `n` jobs that need the plan, on `blacksmith-4vcpu-ubuntu-2404`. Each checks out the admitted SHA with `persist-credentials: false`, installs it with `npm ci`, runs `melian mutants verify <base.sha>...<head SHA> --shard <plan> <k>`, and uploads its report as an artefact. A shard holds no secret, has `permissions: contents: read`, and has no cache step; whatever its head code writes to the Actions cache carries no signature, so nothing reads it.
4. **Report**, which runs no head code. It runs after the pending job even when the plan or a shard fails or the plan holds no mutants. It downloads the plan and every shard's report, and decides with `melian mutants verdict`. It writes the cache entry of section 3. It sets `melian/mutants` on the head and posts one comment listing every survivor, timeout and set-aside file. The comment and status go out as `melian-status-bot`, from an Environment whose deployment branches are the default branch alone, as the round's do.

It runs once on the final head, after the last fix pass, beside the round that sets `melian/review`. The aim is 15 minutes of wall time for 300 mutants or more. The build's report records each shard's time.

### 3. The cache **[Melian's flow]**

When a cached result matches, Melian does not run that mutant again, and counts the earlier result as this head's.

Reuse happens only in jobs that run no head code. Stryker's own incremental mode is never used: every shard runs Stryker with `--force` and no incremental file. Problem: a shard runs the head's Vitest configuration and tests, so anything a shard reads, a seed included, the head's code can replace before Stryker reads it, and Stryker marks no reused result as reused. Example: a head's `vitest.config.ts` rewrites the staged seed to record `Killed` for every mutant, and the merged report would carry those kills as genuine.

An entry is Melian's own record of one run, never Stryker's report. It is for one head, named in its key. For each mutant the run killed, it holds the mutant's `identityHash` and the killing test's file and full name. It also holds the run's installation, executor, policy and Melian identities. The report job alone writes it, from the shards' reports, and signs it with an HMAC key its Environment holds. The plan job checks the signature, applies the rules below, and drops each reusable span group from the shards' work: a group is reused only when every one of its members is. The report job counts the reused kills from the signed entry beside the shards' results. A shard can still write the Actions cache, since its token reaches every step, but nothing unsigned is read. Example: pull request A's tests save an entry keyed to pull request M's head, recording `Killed` for M's mutants; M's plan job finds no valid signature and runs them.

Only these are reused:

- **Kills.** Only `Killed` results are reused; every other status runs again.
- **The same installation and executor.** The lockfile's digest, the Node version, the versions of Stryker and Vitest each equal the reading run's own, and the executor is the same: the runner image's name and version, by the ruling on choice 5.
- **The same policy.** The digest of the effective configuration Stryker ran under: the base's `stryker.config.json` and `vitest.stryker.config.ts`, every file either imports such as `scripts/stryker-test-names.mjs`, the head's `vitest.config.ts`, and the options Melian sets, equal the reading run's own.
- **The same Melian.** The commit of the Melian build that ran, so a later fix to these rules voids every older entry.
- **The same head.** A kill is reused only by a run at the commit that proved it, by the ruling on choice 4. A later commit, a rebase or a merge of `main` starts cold.

Left out of the key, with reasons: the shard plan, because a result belongs to its mutant; the run's times; and the pull request, since the head commit already names everything the run read from it. An entry's name carries the format version, `melian-mutants-v1`; a change to what it holds is a new version, and older entries are never read.

### 4. Survivors and accepted answers **[Building Melian]**

A builder answers each survivor in one of three ways. A new test kills it on the next run. An equivalence reason says why no test can kill it. Or a hand proof, recorded as a builder's run is today, shows a test killing it where Stryker cannot reach it. A file the enumerator can mutate but no test relates to keeps one obligation per mutant, each answered by a hand proof of its own. A file the enumerator cannot mutate, such as configuration or signal-sending code, has no mutants to prove, so it is settled by an accepted answer for the file that says how its changed lines are tested; that settles the file, and proves no mutant. A reason, a hand proof or a settlement counts only once the coordinator accepts it, by the ruling on choice 1.

An answer names a mutant by the `identityHash` core already gives an inventory row, or a set-aside file by its path, with the head's tree, `.melian/mutants/` left out, at the head it was written for. A hand proof also names the policy commit, the test's file and full name, the command and the installation it ran under, and matches only a plan with the same policy commit and installation; under any other, it is a survivor again. An equivalence reason is about the code alone, so the tree is its whole key. Every answer's key also holds the SHA-256 of the answer's own canonical text, and an acceptance names that hash, so a later edit to an accepted answer is an answer nobody accepted. When an accepted answer matches a survivor, Melian does not fail the job for it. Any change to the tree outside that directory voids the answer. Problem: an equivalence argument can rest on a callee, a validator or a configuration the answer never names, so a key on the files an answer cites lets a later change make the mutant observable while the answer still passes it. Example: an answer says `>=` and `>` agree because a caller never passes 0; the caller changes, and the cited file does not. The tree is the one key the answer's author cannot leave something out of. It costs a fresh answer after any later change, and the job runs once, on the final head, so that is rare. `.melian/mutants/` is left out of the tree because adding the answer would otherwise change the tree it names; the answer's own hash covers it instead.

### 5. The status **[Building Melian]**

The report job sets `melian/mutants` on the head it verified:

- `success` only when every obligation the plan lists has its evidence: each mutant proved, noted, or a survivor with an accepted answer, and each set-aside file answered as section 4 says. A plan with neither mutants nor set-aside files has none, and passes.
- `failure` when a survivor or a set-aside file has no accepted answer. The description counts each.
- `error` when the reports cannot decide.

The pending job sets `pending` straight after the gate, before planning, so a run that dies in planning or in a shard leaves `pending`, never an earlier `success`. Runs of one pull request queue behind one another in a concurrency group, as the round's do. The report publishes only while the status its own pending job set is still the head's latest `melian/mutants`, so a slower earlier run, or a rerun of failed jobs, never overwrites a newer result. The maintainer alone makes the context required, and only once a merge-group step exists. That step may pass a merge group only on evidence for the group's own commit, which is a run there, since a kill is reused only at the commit that proved it. Carrying a head's `success` into the group, as `melian/review` does, is not enough, because a later base commit can change what a test reaches. The step is its own decision.

### 6. What decides, and what fails closed **[Melian's flow]**

One rule closes the class three reviews met one instance at a time: `success` needs evidence for every obligation the plan lists, at the plan's head and policy commit, and anything else reads `error` or `failure`. A merge-group check of the context needs evidence at the group's own base, as section 5 says.

`verdict` reads `error`, never a pass, when:

- a shard's report is missing, does not parse, or names another plan, head, installation, policy or Melian build;
- the shards' mutants are not the plan's exactly once each;
- the pull request's head, or its `base.sha`, is not the plan's when the report reads it again before publishing.

### 7. What happens to the decisions it amends

- Enumeration and sampling, section 1 of the 2026-10-24 decision, stand as built in [issue #239](https://github.com/melian-agent/melian/issues/239).
- That decision's `verify`, and its section 3 classifier, are not built. The classifier would have run seven shared control runs per test, in fresh worktrees. Stryker's in-place build is a switched build: every mutant compiles into the file and is switched on at run time. So a test that reads source text cannot tell a mutant from the original, which was that section's main concern. Its two-failure rule goes, by the ruling on choice 3: one failing run proves a kill.
- Its section 4 probes and section 6 `mutants` check wait for their own step. When built, they run through this decision's runner. What they say a timeout is gives way to the ruling on choice 2: a timeout is a kill.
- Its section 5 exact-head rule stands: a kill is reused only at the commit that proved it, by the ruling on choice 4.
- The 2026-11-04 decision's named test alone gives way to Stryker's per-test coverage: a mutant runs against every test that covers it.
- `static.mutation` keeps every rule of [mutation reruns, as built](2026-10-16-mutation-reruns-later-changes.md), its `provisional` status included, as an opt-in audit. The job is not that check, and its reuse can pass because section 3 says what a match decides.
- The build's pull request retires [the waiver](2026-11-10-final-rerun-waived-until-mutants-verify.md) with a decision of its own. AGENTS.md then drops the hand proof of kills from Briefs and Validation, keeps it for set-aside files, and shrinks a builder's inventory to its survivors' answers.

### 8. Keys

When the build lands, two rows join the pipeline's table in [the identity guideline](../guidelines/identity.md#the-keys-melian-has):

| Key | Built in | When it matches, Melian | Left out, and why |
| --- | --- | --- | --- |
| Mutants cache entry, and its prune | `pipeline/src/mutants-cache.ts` | reuses a kill without running the mutant | The shard plan, since a result belongs to its mutant. Times. The pull request, which only finds an entry |
| Accepted survivor answer | `core/src/mutation-inventory.ts`'s `identityHash`, with the head's tree and the answer's own hash, and for a hand proof its policy commit and installation | does not fail the job for that survivor | `.melian/mutants/` from the tree, since adding the answer would change the tree it names; the answer's hash covers it |

## The maintainer's rulings

The maintainer ruled on 2026-11-13, in the coordinator's session, as the coordinator relayed to this builder. The coordinator put the choices to him lettered A to E in this decision's order, so A is choice 1 and E is choice 5. His words: "A. agree. B. agree C. Yes. D. Without the reuse, why would it take less time than now? explain E. Any runner of the same type." A and B agreed with the coordinator's recommendations. On D he asked a question first, which the section "Where the time comes from" answers, and then ruled the same day: "same commit for now".

### Choice 1 (A): the coordinator accepts, from a file in the head

Answers live in `.melian/mutants/answers.yaml`, committed in the head. It is a policy file, so each new answer raises an acknowledge finding. The coordinator reads each answer and records its acceptance on the pull request, and the maintainer reads the coordinator's reports. This ruling is where the coordinator's standing authority of 2026-10-17 is written down: to accept equivalent mutants with reasons, hand proofs and file settlements, and to read policy notices, reporting each. No earlier decision file recorded that grant.

`melian/mutants` reads `success` before the coordinator has read an answer. Builders and the maintainer post as one login, so the job cannot tell who wrote an answer or whether anyone read it. The Ready and queued rule is the gate: a builder queues only after the coordinator has recorded its read. The record names the blob of `answers.yaml` it read, and the builder checks that blob is still the file at the queued head, since a later commit could otherwise change an accepted answer without changing its key. The job checks none of this. The ruling amends the 2026-10-24 decision's rule that an equivalent claim stays unresolved until a maintainer dismisses it, as this decision's first `Amends:` line declares.

Two options lost. The maintainer reading every answer would have narrowed the coordinator's authority and cost him a read per answer. Answers read from the default branch only would have made the merge the acceptance, at the cost of a second pull request for each batch of answers.

### Choice 2 (B): a timeout is a kill

A `Timeout` proves a mutant, as Stryker counts it, and the report lists every timeout by mutant. The lost option counted it a survivor, as the 2026-10-24 decision did.

### Choice 3 (C): one failing run proves a kill

A `Killed` result from one run proves a mutant. Stryker's dry run is the unmutated control: every covering test passes once before any mutant runs. The lost option ran each shard's kills a second time, cold, at about double the shard time.

### Choice 4 (D): a cached kill comes from the same commit, for now

A run reuses only kills a run at the same head proved. The reshape's seed from `main` is dropped for the first build. "For now" is the maintainer's word: reuse from earlier heads is a later step, with a decision and measurements of its own, not a rejected one. The attacking review's findings are its starting point. An earlier head must be an ancestor and present in the clone, since Vitest's `--changed` diffs from the merge base and lists nothing for a ref it cannot find. The targeted-rerun rule would void most seeds, because every pull request adds a progress-log file. And Vitest's import graph misses what a spawned child imports.

### Choice 5 (E): any runner of the same type is the same executor

The executor is the runner image, as named and versioned, together with the installation identity, so a second run on any runner of that image reuses kills. This amends the 2026-10-24 decision's rule that a record is reused only on the physical executor that made it. The lost option, the physical runner, would have allowed no reuse in Actions.

## Where the time comes from

The maintainer asked why the job would be faster than today without reuse. Today a builder runs each mutant by hand against its named test, one at a time: [pull request #310](https://github.com/melian-agent/melian/pull/310)'s 689 took about 3.5 hours, each mutant paying a process start and its test file's load. The job's time has three parts, and none needs reuse:

1. Checkout and install, about 1 to 2 minutes, paid by every shard at once.
2. Stryker's dry run: the tests related to the shard's files, once, with per-test coverage. Every shard pays it in parallel, so it does not shrink with more shards. For a file most tests import, it is close to the whole suite: AGENTS.md records 8 minutes for a `static.mutation` dry run on the host, and the gate's tests take about 10 minutes in a cloud container.
3. The mutants: 689 over 16 shards is about 43 each. Each runs against only the tests that cover it, in Vitest workers that stay up, so no mutant pays a process start. `static.mutation` measured about 20 mutants a minute on 2 workers, so 4 workers take about 2 minutes for 43.

So a shard takes about 11 to 14 minutes, and the dry run is most of it. The 13 minutes of the reshape is 3.5 hours over 16 shards; it lands close for these reasons, not by division. Reuse cuts only part 3, and only on a later run. The build's recorded run is the measure.

## What this gives up

- Runner time: 16 shards of about 11 to 14 minutes are about 3 to 4 runner-hours on 4-vCPU machines per run.
- A flaky test can fake a kill, since one failing run proves one, by the ruling on choice 3.
- A timeout from a slow runner can pass a mutant no test detects, by the ruling on choice 2.
- A kill reused across runners of one image can hide a timing-sensitive survivor, by the ruling on choice 5.
- `melian/mutants` can read `success` before the coordinator has read an answer, by the ruling on choice 1; the Ready rule is the gate.
- Files reached only through a spawned process keep a hand proof.
- Whatever the chosen options give up, as each says.

## For the attack

Each rule is to be broken as written.

1. A shard runs head code only under `static.mutation`'s leave, and the Actions job admits only the round gate's heads, at the SHA the pending job recorded. A shard holds no secret, has `contents: read` and `persist-credentials: false`, and has no cache step.
2. Stryker runs under the base's configuration with Melian's options over it, on whole span groups, so each mutant runs in exactly one shard. `Killed` and `Timeout` prove a mutant; a mutant whose mutator is in the base's `excludedMutations` is noted; every other status is a survivor.
3. A cache entry is Melian's own signed record, read and applied only by jobs that run no head code; shards run Stryker cold. Only `Killed` results are reused, only at the commit that proved them, under the installation, runner image, policy and Melian identities, and a span group is reused only whole.
4. An accepted answer matches a survivor by `identityHash`, or a set-aside file by its path, and the head's tree outside `.melian/mutants/`, and it counts only from `.melian/mutants/answers.yaml` in the head, once the coordinator has accepted it. `success` needs an accepted answer for every survivor and every set-aside file.
5. `verdict` reads `error` whenever the reports do not cover the plan's mutants exactly once, or name another plan, head, installation, policy or build, and whenever the pull request's head or `base.sha` has moved from the plan's.
6. A job that runs no head code sets `melian/mutants` to `pending` straight after the gate, before planning, and a report publishes only while that pending status is the head's latest.
