# `melian mutants verify` runs Stryker in sharded Actions jobs, and builders justify only survivors

Amends: [mutation evidence by enumeration and verification](2026-10-24-mutation-evidence-by-enumeration-and-verification.md), section 1's `verify` command, section 3's verification as evidence, section 5's stale kills and section 8's changes to this repository, for how a pull request's kills are proved
Amends: [Stryker leaves this repository's review rounds](2026-10-24-stryker-off-the-hot-path.md), the interim rule, which ends when the job lands
Amends: [a mutation proof runs each claim against its named test alone](2026-11-04-mutation-proof-scope.md), who runs a kill's proof and against which tests
Amends: [rerun only the mutant claims a later change could affect](2026-11-07-targeted-mutant-rerun.md), whose selection becomes the rule for reusing a cached kill

Status: proposed on 2026-11-13 for [issue #240](https://github.com/melian-agent/melian/issues/240), for the maintainer's ruling. Not built. The maintainer reshaped step 34 on 2026-11-10, in the coordinator's session, as [the coordinator recorded on the issue](https://github.com/melian-agent/melian/issues/240#issuecomment-6754427946): Stryker proves the kills, with per-test coverage and an incremental cache seeded from `main`, across a matrix of Blacksmith runners, once on the final head beside the round, and builders justify only survivors. The rules below are this decision's own and await the ruling. A job that fails a pull request on survivors changes what blocks, so [the convergence rules](2026-10-15-review-loop-convergence-rules.md) require an attacking review before a build starts. Each part is tagged **[Melian's flow]** for the product or **[Building Melian]** for this repository's process.

## Problem

A builder proves each kill by hand: a scratch script applies one mutant, runs its named test, and records the failure. On [pull request #310](https://github.com/melian-agent/melian/pull/310), 689 claims took about 3.5 hours in the builder's session. [The waiver](2026-11-10-final-rerun-waived-until-mutants-verify.md) dropped the final rerun of earlier claims to save that time, so a later change that lets an earlier kill survive now merges unseen.

The two designs on file are both too slow. [The enumeration and verification decision](2026-10-24-mutation-evidence-by-enumeration-and-verification.md) runs each claim in fresh worktrees, with seven shared control runs per test. By its own measurement, that is up to 204 minutes serial for [pull request #168](https://github.com/melian-agent/melian/pull/168)'s 328 mutants. `static.mutation` ran Stryker cold and unsharded on the host, and took 30 minutes to 2 hours a round.

Example: on #310's 689 mutants, a 16-way split of Stryker's per-test runs, each mutant against only the tests that cover it, would aim at about 13 minutes of wall time.

## Decision

### 1. The commands **[Melian's flow]**

Two commands join `melian mutants list` and `sample`. The Actions job of section 2 only calls them, so a customer or a host gets the same proof without Actions.

- `melian mutants verify <range|#pr> [--shard k/n] [--json] [--out <path>] [--trust-head]` runs Stryker over the changed production lines that `melian mutants list` enumerates, in the checkout of the head. With `--shard k/n`, it runs only shard `k` of `n`, by the plan of section 2. It writes a shard report: the plan's digest, the shard's mutants by identity, each mutant's Stryker status, its covering and killing tests, and the installation and policy identities of section 3. It runs head code, so it takes the leave `static.mutation` takes: a head a writer pushed to the base repository, or `--trust-head`. Exit codes: `0` when the run finished, whatever its mutants did; `2` when it could not run; `64` for usage.
- `melian mutants verdict <report>... --plan <plan>` reads every shard's report and the accepted reasons of section 4, and prints the result. It runs no head code. It exits `0` when every mutant passes, `1` when a survivor has no accepted reason, and `2` when the reports cannot decide, as rule 6 says.

The run uses this repository's configuration and Stryker's own runner, with:

- `coverageAnalysis: perTest`;
- Vitest's `related` selection;
- the `strykerTestNames` plugin, so a test inside a `describe` runs;
- `ignoreStatic: false`, so a module-level mutant runs against the tests that load it;
- the `excludedMutations` read from the base's `stryker.config.json`.

A shard whose files relate to no test runs them against the whole suite, as `static.mutation`'s repeat does. Files the enumerator sets aside, such as signal-sending code and configuration, are listed in the report and keep their hand proof on a fake.

Stryker's statuses map to three outcomes:

| Stryker status | Outcome |
| --- | --- |
| `Killed`, `Timeout` | proved |
| `Survived`, `NoCoverage`, `RuntimeError`, `CompileError` | survivor |
| `Ignored` by the base's `excludedMutations` | noted |

`Timeout` counts as detected, as Stryker counts it. That relaxes section 3 of the decision it amends, so the report lists every timeout by mutant. A `// Stryker disable` comment stays the `forged-mutation-kill` guardrail's to report, and the mutants it hides count as survivors.

### 2. The job **[Building Melian]**

`.github/workflows/melian-mutants.yml` is a `workflow_dispatch` workflow on the default branch, with a `pull_request` input. It builds Melian and every helper script from the default branch's commit, as `melian round` does. It takes only the heads the round's gate takes: a branch of this repository, pushed by a writer, in a pull request into the default branch. It refuses a fork's head, a head a bot pushed, and a stacked pull request.

Its jobs:

1. **Plan**, which runs no head code. It enumerates the mutants with `melian mutants list "#N" --all --json`, from git alone. It splits them into `n` shards balanced by mutant count, keeping a file's mutants together while they fit, and splitting a file's line ranges when one file holds more than a shard's share. `n` is the mutant count over 45, rounded up, at most 16. The plan names each shard's mutants and the head and base it was made for, and its digest is the SHA-256 of its canonical JSON.
2. **Shards**, a matrix of `n` jobs on `blacksmith-4vcpu-ubuntu-2404`. Each checks out the head, installs it with `npm ci`, restores the cache of section 3 read-only, runs `melian mutants verify "#N" --shard k/n`, and uploads its report as an artefact. A shard holds no secret and no login, has `permissions: contents: read`, and saves no cache.
3. **Report**, which runs no head code. It downloads every shard's report and decides with `melian mutants verdict`. It writes the cache entry of section 3. It sets `melian/mutants` on the head and posts one comment listing every survivor, timeout and set-aside file. The comment and status go out as `melian-status-bot`, from an Environment whose deployment branches are the default branch alone, as the round's do.

It runs once on the final head, after the last fix pass, beside the round that sets `melian/review`. The aim is 15 minutes of wall time for 300 mutants or more. The build's report records each shard's time.

### 3. The cache **[Melian's flow]**

When a cached result matches, Melian does not run that mutant again, and counts the earlier result as this head's.

The cache holds Stryker's incremental report, as Stryker writes it, under a key that names the pull request, the installation, the policy and the head. The pull request only finds the seed below; it decides no reuse. Stryker's own differ reuses a kill when the mutated code and the killing test's text are unchanged. It reuses a survivor when no covering test was added. It does not look at anything else a test imports. Example: `a.test.ts` kills a mutant in `a.ts` through `b.ts`. A later change to `b.ts` alone lets Stryker reuse the kill, though the test may no longer reach the mutant. [The targeted-rerun decision](2026-11-07-targeted-mutant-rerun.md) met the same example and ruled on it. So Melian prunes the report before Stryker reads it, and Stryker only ever sees results Melian allows:

- **Installation.** No result is reused unless these equal the reader's: the lockfile's digest, the Node version, the versions of Stryker and Vitest, and the runner image's name and version. A different machine type is a different installation.
- **Policy.** No result is reused unless these equal the reader's: the digest of the base's `stryker.config.json`, `vitest.stryker.config.ts` and `vitest.config.ts` as committed, and of the options Melian passes to Stryker.
- **Kills only.** Only `Killed` results are reused. A survivor or a timeout runs again every time; it costs little, since a survivor fails the job anyway.
- **The same head.** At the head that wrote the entry, every kill is reused.
- **Another head.** A kill from seed head `S` is reused at head `H` only when the targeted-rerun rule leaves it alone. Its killing test file is not on `vitest list --filesOnly --changed S` at `H`. Its mutated file and killing test file are unchanged in `git diff --name-status S..H`. And that diff holds no file Vitest's graph does not track, and no Vitest configuration, `tsconfig`, `package.json` or lockfile. Otherwise every result from `S` runs again. Vitest runs that listing in the shard, so it is head code, under the shard's leave.

The seed is the newest entry for the same pull request's earlier heads, and otherwise the newest entry whose head is an ancestor of `H`. A merged pull request's final head is an ancestor of `main`, so this is the seed from `main`. Without an entry, the run starts cold.

Left out of the key, with reasons:

- The head, for another head, because the targeted-rerun rule decides that case.
- The shard plan, because a result belongs to its mutant.
- The run's times.

Only the report job writes an entry, and only from a run whose gate admitted the head and whose every shard reported. A shard's report comes from a run of the head's tests, which can alter it, as it can alter any test result. A writer's head is trusted to that extent, and no other head runs. An entry's key carries the format version, `melian-mutants-v1`; a change to what it holds is a new version, and older entries are never read.

### 4. Survivors and accepted reasons **[Building Melian]**

A builder answers each survivor in one of two ways. A new test kills it on the next run. Or an equivalence reason says why no test can kill it. A reason counts only once accepted.

Accepted reasons live in `.melian/mutants/equivalent.yaml`, committed in the head. Each entry names a mutant by the `identityHash` core already gives an inventory row, and the blob of the mutant's file at the head the reason was written for, with the reason and its acceptance: who accepted it, the date, and where. When an entry matches a survivor, Melian does not fail the job for it. The blob is in the key, so any edit to the file voids the entry: an equivalence argument rests on the code around the mutant, and an edit can break it. When unsure, include. A later decision may narrow it to the enclosing function once the cost of re-accepting shows.

The maintainer accepts a reason. The builder writes the entry and asks the maintainer in its own session, as Work from issues says. The file is policy: `isPolicyFile` counts every file under `.melian/mutants/`. So a change to it raises `policy-change-review` at `acknowledge`, and the Ready rule already has the builder record the maintainer's read before queueing. The job cannot tell who wrote an entry, because builders and the maintainer post as one login. The Ready rule enforces acceptance, as it does for every acknowledge finding.

The alternative was weighed: the coordinator accepts. It reads code it did not write, and costs the maintainer nothing. It is not the choice, because an accepted reason unblocks a pull request, and AGENTS.md sends anything that changes blocking behaviour to the maintainer. The maintainer may rule otherwise.

An entry stays on `main` after its pull request merges. One whose file has since changed never matches again.

### 5. The status **[Building Melian]**

The report job sets `melian/mutants` on the head it verified:

- `success` when every mutant on a changed production line is proved, noted, or a survivor with an accepted reason.
- `failure` when a survivor has none. The description counts the survivors.
- `error` when the reports cannot decide.

The job sets `pending` before the shards start, so a run that dies leaves `pending`, never an earlier `success`. The maintainer alone makes the context required, as for `melian/review`. A merge-group check of it is a later step.

### 6. What decides, and what fails closed **[Melian's flow]**

`verdict` reads `error`, never a pass, when:

- a shard's report is missing, does not parse, or names another plan, head or installation;
- the shards' mutants are not the plan's exactly once each;
- the head or base moved during the run;
- a shard ran Stryker without per-test coverage, since its differ then reuses every result.

### 7. What happens to the decisions it amends

- Enumeration and sampling, section 1 of the 2026-10-24 decision, stand as built in [issue #239](https://github.com/melian-agent/melian/issues/239).
- That decision's `verify`, and its section 3 classifier, are not built. The classifier would have run seven shared control runs per test, in fresh worktrees. Stryker's in-place build is a switched build: every mutant compiles into the file and is switched on at run time. So a test that reads source text cannot tell a mutant from the original, which was that section's main concern. Its two-failure rule goes. A flaky test can now fake a kill, which is accepted in section 8.
- Its section 4 probes and section 6 `mutants` check wait for their own step. When built, they run through this decision's runner.
- Its section 5 exact-head rule gives way to section 3 here, for kills only.
- The 2026-11-04 decision's named test alone gives way to Stryker's per-test coverage: a mutant runs against every test that covers it.
- The 2026-11-07 decision's selection becomes the cache's reuse rule, word for word.
- `static.mutation` keeps every rule of [mutation reruns, as built](2026-10-16-mutation-reruns-later-changes.md), its `provisional` status included, as an opt-in audit. The job is not that check, and its reuse can pass because section 3 says what a match decides.
- The build's pull request retires [the waiver](2026-11-10-final-rerun-waived-until-mutants-verify.md) with a decision of its own. AGENTS.md then drops the hand proof of kills from Briefs and Validation, keeps it for set-aside files, and shrinks a builder's inventory to its survivors' answers.

### 8. Keys

When the build lands, two rows join the pipeline's table in [the identity guideline](../guidelines/identity.md#the-keys-melian-has):

| Key | Built in | When it matches, Melian | Left out, and why |
| --- | --- | --- | --- |
| Mutants cache entry, and its prune | `pipeline/src/mutants-cache.ts` | reuses a kill without running the mutant | The head, for another head, which the targeted-rerun rule decides. The shard plan, since a result belongs to its mutant. Times |
| Accepted equivalence reason | `core/src/mutation-inventory.ts`'s `identityHash`, with the file's blob | does not fail the job for that survivor | Nothing |

## What this gives up

- A flaky test can fake a kill. Stryker runs a mutant once, so an honest test that fails by chance kills it. The earlier design's two separated failures and control windows caught that, at seven runs per test.
- Cross-head reuse trusts Vitest's import graph. A test that spawns a child process reaches modules the graph does not see, so a change to one of them can leave a stale kill. The targeted-rerun decision gave up the same case.
- Timeouts count as kills.
- Runner time: 16 shards of about 13 minutes are about 3.5 runner-hours on 4-vCPU machines per run.
- The maintainer reads every equivalence reason.

## For the attack

Each rule is to be broken as written.

1. A shard runs head code only under `static.mutation`'s leave, and the Actions job admits only the round gate's heads. A shard holds no secret, has `contents: read`, and saves no cache.
2. `Killed` and `Timeout` prove a mutant. `Survived`, `NoCoverage`, `RuntimeError` and `CompileError` fail it without an accepted reason. A mutant the base's `excludedMutations` ignores is noted, and one a comment ignores is a survivor.
3. Only `Killed` results are reused, and only under the installation, policy and targeted-rerun rules of section 3, applied by Melian before Stryker reads the report.
4. The report job alone writes a cache entry, from a run whose every shard reported, and nothing a head writes reaches an entry another way.
5. An accepted reason matches a survivor by `identityHash` and the file's blob, and it lives in a policy file, so adding one raises an acknowledge finding the maintainer reads before the queue.
6. `verdict` reads `error` whenever the reports do not cover the plan's mutants exactly once, name another plan, head or installation, or come from a run without per-test coverage.
7. `melian/mutants` is `pending` from the start of a run, so no run leaves an earlier head's `success` standing on this head.
