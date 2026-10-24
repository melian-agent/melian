# Mutation evidence comes from enumeration and verification, and Stryker leaves the hot path

Amends: [tested means a failing mutation](2026-10-07-tested-means-a-failing-mutation.md), the static check as the proof of a kill
Amends: [mutation reruns, as built](2026-10-16-mutation-reruns-later-changes.md), the check's place in Melian's own tiers, the cold final run, and the source of `untested-behaviour`
Amends: [builder mutant inventory](2026-10-21-builder-mutant-inventory.md), the script, the claim evidence, and the authority
Amends: [builder inventory sampling](2026-10-21-builder-inventory-sampling.md), the command that samples and the inventory version
Amends: [builder inventories execute trusted checkout code](2026-10-21-builder-inventory-trusted-checkouts.md), the pinned implementation a review uses
Amends: [static checks run unconfined](2026-10-14-static-checks-run-unconfined.md), the leave a verification run and a probe need
Amends: [the trust floor](2026-10-17-trust-floor-exact-rule.md), a refutation by the probe executor
Amends: [lens budgets](2026-10-04-lens-budgets.md), the probe budget
Amends: [the convergence rules](2026-10-15-review-loop-convergence-rules.md), rule 2's mutation check on fix commits

For plan step 34, before any code. The maintainer ruled on 2026-10-24. It must be attacked before a build starts. Every part is tagged: **[Melian's flow]** is the product, and **[Building Melian]** is this repository's own process.

## The maintainer's rulings

1. Remove Stryker from the hot path entirely. No cold final run, no mutation-only pre-round run, no periodic full sweep is required.
2. Build `--verify`: apply a mutant and run only the named test.
3. Make enumeration and verification extensible to any language.
4. Make enumeration and verification available to downstream Melian customers, so they can use them in their own builders' prompts.
5. For all Melian users, this repository and customers alike, the tests lens uses enumeration and verification.

## Problem

**[Building Melian]** `static.mutation` runs Stryker on every full round. It costs 15 to 70 minutes of host time, with an 8- to 19-minute dry run. Under load it made rounds read `not reviewed`, and a stopped run leaves locked scratch worktrees. Six enumeration-first passes on 2026-10-22 to 2026-10-24 left it nothing real to find: [pull request #168](https://github.com/melian-agent/melian/pull/168) fixes 1 and 2, [pull request #171](https://github.com/melian-agent/melian/pull/171) and its fix, [pull request #174](https://github.com/melian-agent/melian/pull/174), and [pull request #186](https://github.com/melian-agent/melian/pull/186). Every claim Stryker could check held. Before enumeration, hand inventories missed coverage, not accuracy: on [pull request #168](https://github.com/melian-agent/melian/pull/168) the builder covered 18% of 242 mutants, and all ten of Stryker's survivors sat in the rest. [Issue #177](https://github.com/melian-agent/melian/issues/177) holds the summary.

**[Melian's flow]** A builder's claim that a named test kills a mutant is checked today only by a whole Stryker run, or by hand. The `tests` lens reads for an untested behaviour and names "the mutation every test lets through" in prose. Nothing runs that mutation, so a verifier judges a guess against a guess. Enumeration covers TypeScript and JavaScript alone, through Stryker's instrumenter, so a repository in another language gets no mutation proof at all, as [issue #170](https://github.com/melian-agent/melian/issues/170) records.

Example: the `tests` lens reports "deleting the `attempts--` in `fetchWithRetry` passes every test". The verifier reads the tests and agrees it is plausible. Nobody deleted the line and ran the tests. On [pull request #116](https://github.com/melian-agent/melian/pull/116), the late rounds found such gaps one at a time, and each took a round.

## Choice

Mutation evidence is a record that a named test killed a named mutant at a named head, made by applying the mutant and running that test. Melian enumerates mutants deterministically, a builder or a lens claims which test kills each, and a verification run checks each claim. The `tests` lens receives the enumeration and backs each `untested-behaviour` finding with a probe that shows the mutant survives. Stryker leaves Melian's own tiers. `static.mutation` stays in the product as an opt-in audit.

### 1. The CLI **[Melian's flow]**

`scripts/enumerate-mutants.mjs` and `scripts/mutant-sample.mjs` fold into three commands. The capability lives in the packages, reachable from the CLI, because the skills only call the CLI.

- `melian mutants list <range|#pr> [--json] [--limit N] [--all]` enumerates the mutants of the changed production lines. It writes the inventory, version 2 below. `--limit` keeps today's default of 200 rows and reports the omitted count; `--all` lists every row. It runs no test and no head code: it reads committed source through git and instruments it in an empty scratch directory. For a pull request it fetches the head as `review` does. Exits `0`; `1` when the range cannot be resolved or no adapter handles the changed files; `64` for arguments it cannot read.
- `melian mutants sample <inventory>` prints the probes a classified inventory owes, by today's rule: every `new-test` and `equivalent` claim, then one probe per represented survivor class, mutator and file, then 20% of each file's remaining `killed` claims, rounded up. SHA-256 of the JSON tuple `[file, line, column, endLine, endColumn, mutatorName, replacement]` orders candidates and ties, lowest first, and the output prints each probe's hash so a reviewer reproduces it. An incomplete inventory, an unclassified claim, missing evidence or an unknown class label is refused. Exits `0`, `1` refused, `64` usage.
- `melian mutants verify <inventory> [--all] [--json] [--jobs N] [--out <path>]` applies each sampled mutant, or with `--all` every mutant that carries a claim, and runs the named test. It records each outcome in the inventory, which it rewrites at `--out`, by default the inventory's own path, and in the repository's mutation cache as a verification record. It exits `0` when every verified claim held and no `new-test` claim remains. It exits `1` when a claim did not hold or a `new-test` claim still waits for its test, listing each. It exits `2` when verification could not run: a missing adapter tool, a head that is not the checkout's, or a run past its bound. `64` is usage. Output names each mutant, its claim, the test, the outcome and the time taken.

The inventory is a versioned JSON document, `melianMutants: 2`:

- `range`: `base` and `head` commits, and the review target when it was a pull request.
- `adapters`: each language adapter that enumerated, with its identity: the adapter name and version and the enumerator tool's version, such as `typescript: stryker-instrumenter@9.1.0`.
- `installation`: the installation identity the mutation cache already computes, a digest of the checkout's lockfiles, the test runner's version and the Node runtime version.
- `mutants`: one row per mutant, keyed by `id`, the hex SHA-256 of the identity tuple above. Each keeps `file`, `line`, `column`, `endLine`, `endColumn`, `mutatorName`, `replacement`, `status` (`generated` or `ignored`, with the instrumenter's `statusReason`), and the builder's `claim`, `evidence` and `survivorClasses`. A `killed` claim's evidence is `{ test: { file, name } }`, the test file and its full name, as the runner reports it. An `equivalent` claim's evidence is `{ reason }`. A `new-test` claim's evidence is `{ test }` for the test the builder will write. `verification`, when present, is the record below.
- `unmutated`: the changed production files the enumerator set aside, with the reason, as today.

A version-1 inventory, today's shape with string evidence, is accepted by `sample` and refused by `verify`, which says to enumerate again: a string cannot name a test the runner can run. The survivor class labels stay the builder's judgement and the eight names of today.

### 2. The language adapter **[Melian's flow]**

A `MutationAdapter` is a class in the pipeline, since enumeration and verification spawn processes. It answers four questions, and nothing else:

1. `enumerate(files)`: the mutants of the given files' changed line ranges, from the file text at the head. It never runs the repository's code or loads its configuration.
2. `apply(mutant, text)`: the file text with one mutant spliced in at its byte range, or `invalid` when the result does not parse. The adapter is the authority on positions and parsing.
3. `testCommand(test, root)`: the command that runs one named test, `{ file, name }`, in a scratch worktree at `root`, and how to read its result.
4. `classify(outcome, baseline)`: `killed`, `survived`, `invalid` or `timeout`, from the command's exit, its report and its duration against the bound.

The TypeScript adapter is the first. It enumerates through `@stryker-mutator/instrumenter` as a library, spawned in an empty scratch directory with the file texts on standard input, as the script does today, never through Stryker's runner. It applies a mutant by splicing the instrumenter's replacement at its range. It runs one test through Vitest, `vitest run <file> -t <anchored full name>`, with the head's configuration untouched, and reads Vitest's JSON reporter. Vitest strips types without checking them, so a type error is not `invalid` here; a mutant whose spliced text Vitest cannot transform is. The instrumenter comes from the checkout's install when it has one, and otherwise from Melian's own pinned copy, as Biome and tsc do; `melian doctor` says which, and the record names the version, since mutant identity depends on it.

Other adapters plug in the same way, each a class behind the interface, selected by `melian.yaml`:

```yaml
mutants:
  evidence: required          # or advisory, the default
  languages:
    typescript: { enumerate: stryker-instrumenter, test: vitest }
    rust: { enumerate: cargo-mutants, test: "cargo test {name} --exact" }
    ruby: { enumerate: tree-sitter, grammar: ruby, test: "bundle exec rspec {file} -e {name}" }
```

- A dedicated tool's adapter, for cargo-mutants, mutmut, PIT, Stryker.NET or mutant, wraps the tool's own enumeration and reads its mutant list into the inventory shape. It applies the mutant by the tool's own means where the tool can apply one mutant alone, and otherwise by the byte range the tool reports. Each is its own class and its own pull request.
- The tree-sitter fallback of [issue #170](https://github.com/melian-agent/melian/issues/170) enumerates from the grammar's syntax tree with a fixed operator table and a small reviewed map per language from node types to operators. It applies by byte range, and its `classify` reads a mutant that fails to parse or compile as `invalid`, never `killed`. It is a floor, not a match for a dedicated tool's semantics, and it is milestone 3 work.

`mutants.languages` is policy: a `test` command executes, so only the committed root `melian.yaml` sets it. A nested file or a preference file that sets it is refused when the file is read, as a committed `melian.yaml` refuses a credential command. A pull request's review reads it from the base, so a head cannot name the command that proves its own kills. `{file}` and `{name}` are the two placeholders; the command runs with the four variables every static tool gets.

### 3. Verification as evidence **[Melian's flow]**

A verification run executes the head's tests. It carries the same trust as `static.mutation` does today, by [the unconfined decision](2026-10-14-static-checks-run-unconfined.md): a head a writer pushed to the base repository, or one the reviewer vouches for with `--trust-head`. A fork's head waits for milestone 3's credential-free job. Nothing confines the run.

One narrow addition to that decision. `melian mutants verify` exists to run the inventory's head's tests, as `npm test` does; the person running it is asking for exactly that. So the command is itself the reviewer's word for the inventory's head, needs no flag, prints that it runs that head's own tests as the user, and records the leave `reviewer`. A review's probe takes no such shortcut: it runs under the review's own leave, writer or reviewer, and a review without leave runs no probe.

The run works in a scratch worktree of the head, linked to the checkout's install as static tools are, with the head's own test runner. For each claim:

1. **Baseline.** The named test runs unmutated once per test file per run. A test that fails unmutated makes every claim on it `invalid-claim`: a failing test kills nothing.
2. **Apply.** The adapter splices the mutant into the file. A mutant that does not parse is `invalid`.
3. **Run.** The named test runs against the mutated file, under `mutants.timeout`, 120 seconds by default.
4. **Classify.** A test that passed unmutated and fails mutated is `killed`. One that passes both ways is `survived`. A run past the bound is `timeout`. A mutated module that the runner cannot load is `invalid`.
5. **Restore** the file, from git, never from memory.

A kill is a test that passes unmutated and fails mutated. Nothing else counts, so an `invalid` mutant is never `killed`, and a `timeout` is a note, as it is in Stryker's report today.

The record is `{ version: 1, head, mutant, test, outcome, baseline, adapter, installation, leave, at, ms }`. Records live in the repository's mutation cache under `CacheLocation`, `mutants/<head>/<installation>/<adapter>/<mutant id>.json`, beside the partition `static.mutation` keeps there. They are cached evidence, not state: losing them costs a run. A record is keyed by the exact head, so a record from another head is never evidence; the stale-kill section says why. A review reads a record only when its own installation identity and adapter identity match and when the review itself has leave to run the head, writer or reviewer. The record's `leave` is kept for the ledger, and either leave is reusable at the same head: both answer that the head's tests may run here, and the record is that head's tests run.

What a record cannot prove: a writer's test can fail only while a mutant is applied, by reading its own source, and a writer can write a record into the cache by hand. That is within writer trust, as it is for `static.mutation`'s staged report today, and human review before merge is the control. The `forged-mutation-kill` guardrail stays for Stryker's active-mutant variable; probes set none.

Measured, on this repository, at a load average of 25 while another lane's gate ran: one named Vitest test in `packages/core` takes 3.3 seconds of wall time, of which Vitest reports 0.5 seconds; a pipeline test that adds a worktree takes 1.8 seconds inside Vitest; a CLI test that spawns `melian` takes about 2 seconds. Process start dominates, so a later build may run the TypeScript adapter's probes through Vitest's node API in one process, as Stryker's runner does, and cut the per-mutant cost to the test's own time.

### 4. The tests lens **[Melian's flow]**

The lens receives the enumeration of its files' changed lines as context, inside the review's boundary under the label `mutants`, since a replacement is head text. The section lists each mutant's ID, file, line, mutator and replacement, with its record at this head when one exists: `killed by <test>`, `survived`, or `unverified`. It holds at most 400 mutants and 64 KiB; past either, it lists counts per file and names the tool that lists the rest. Two read-only tools join the lens: `list_mutants(file)` lists a file's mutants with their records, and `probe_mutant(id, test?)` runs a verification probe. A probe with a named test checks that test alone. A probe without one runs the tests the test runner relates to the mutated file, Vitest's own `related` selection for the TypeScript adapter, and reports the first test that failed as the killer; it never runs the whole suite.

An `untested-behaviour` finding is backed by a probe. `report_finding` under that rule takes `mutant`, the ID of a mutant the lens probed:

- A mutant whose probe survived backs the finding. The finding's failure scenario is the mutation itself, and the verification record is its proof.
- A mutant whose probe killed refuses the report, naming the test that killed it. The lens can look elsewhere.
- No mutant, or an unprobed one, is refused while probes are available: "probe the mutant first". A lens that cannot probe, because the head has no leave or its probe budget is spent, reports as today, and the verifier judges the claim as it does now.

The verifier receives each probe-backed finding with its record in the state. A `survived` record confirms the mechanism: the verifier may not refute it, and may lower its severity one step within the existing fence when the gap is narrow. A `killed` record on a claim, which can only arrive from a report stored before the refusal existed, refutes it. The probe is a third verification executor, `probe`, writing the same record shape with `executor: "probe"` and the record's ID as its evidence. Its refutation supplies no trust-floor minimum, because the refuting evidence is the head's own test killing the mutant, not a model's reading; that is the amendment to [the trust floor](2026-10-17-trust-floor-exact-rule.md). A lens claim the verifier judged without a probe keeps its floor.

The work is bounded per round. Each `tests` lens run has `budget.probes`, 12 by default at `careful`, 6 at `quick`, 20 at `deep`, and `mutants.timeout` per probe. The lens chooses which mutants to probe; Melian only counts. A probe past the budget is refused with a note, counted in the lens's record as a budget end of kind `probes`. The lens goes on reading and reporting. An exhausted probe budget does not end the conversation, because the lens can still report what it probed. Every probe writes a record, so a later round at the same head reuses it. A lens at a head without leave records that probes were unavailable and why.

This replaces `static.mutation`'s survivors as the source of `untested-behaviour` in Melian's own repository. Three things stay.

- `static.mutation` leaves every tier of Melian's `melian.yaml`. It was never in a default tier.
- The check stays in the product as an opt-in audit, unchanged, with its partition, its provisional status and its `--cold` run. It is the one exhaustive run, every mutant against its related tests, and the only measure of what enumeration and claims miss. A repository turns it on for an audit; Melian's own loop no longer runs it on rounds. Removing it would delete working code that the audit needs, and the enumerator shares its selection with it, so the two cannot drift. If an audit shows nothing for three milestones, a later decision may remove it.
- The `forged-mutation-kill` guardrail and the policy-change rules for Stryker's configuration files stay, since the check stays.

### 5. Stale kills **[Melian's flow]**

Problem: a later change to `b.ts` makes an earlier-killed mutant in `a.ts` survive. A test that reached the mutant through `b.ts` no longer does, and `a.ts` is unchanged, so nothing about the mutant or its test file changed. A whole-pull-request Stryker run caught this; nothing else did.

Two options were measured. The first re-verifies a claim when any file in its named test's import closure changes, with Vitest's related selection as the authority. The second re-verifies every claim at the head the review passes on.

The cost of the second, measured with `melian mutants list`'s predecessor on this repository: [pull request #168](https://github.com/melian-agent/melian/pull/168) has 328 mutants in 4 files, [pull request #167](https://github.com/melian-agent/melian/pull/167) 123 in 4, [pull request #174](https://github.com/melian-agent/melian/pull/174) 75 in 1, and [pull request #186](https://github.com/melian-agent/melian/pull/186) 72 in 1. At 3.3 seconds a mutant under load, the largest costs 18 minutes serial and about 5 minutes with four workers; the others under 7 minutes serial. Stryker took 15 to 70 minutes a round on the same pull requests.

Choice: the second. A verification record is evidence for the exact head it names and no other. A review at head `H` reads only records at `H`. A builder runs `melian mutants verify --all` at each head before pushing, which is minutes, and the review reuses those records; the lens probes what has none. Nothing carries across heads, so nothing can go stale, and Melian never re-derives which files a kill depended on. The first option was rejected because Vitest's related selection follows imports alone, and [the coverage ledger decision](2026-10-23-coverage-ledger-and-delta-review.md) found the list of what else can stale a kill, a fixture, a snapshot, a setup file, a Markdown file a test reads, a spawned child's module, and kept growing it. A hand list is the class [the ask-the-authority decision](2026-10-12-ask-the-authority.md) names.

What it misses. A test that passes unmutated and fails mutated by chance; the baseline in the same run narrows that and cannot exclude it. A mutant the enumerator does not generate. An `equivalent` claim, which is a judgement and becomes a survivor finding for the maintainer to dismiss. And the minutes a whole re-verification costs at each head, which the measurement bounds.

### 6. The coverage ledger **[Melian's flow]**

Mutation coverage comes from verification records, not from Stryker's report. [The coverage ledger decision](2026-10-23-coverage-ledger-and-delta-review.md), open in [pull request #185](https://github.com/melian-agent/melian/pull/185), must change in these places; this decision names them and edits none of that pull request's files.

- Its amendment of [mutation reruns, as built](2026-10-16-mutation-reruns-later-changes.md) becomes an amendment of this decision. Its coverage rule for `static.mutation` becomes: a changed production line is covered when every mutant on it has a verification record at the current head that reads `killed`, or is the subject of a survivor finding settled at the current head, or of a dismissal. Lines the enumerator sets aside, and `ignored` mutants, are covered with a note, as `ignoreStatic` lines are today.
- Its round step 2 and attack rule 8, Stryker over the delta's production lines and every carried survivor's line with `--force`, go. Nothing mutates in a round; the lens probes, and the records decide.
- Its voids 7 and 8 for mutation coverage simplify to one sentence: a mutation record from another head is never evidence. The `provisional` status, the dependency and test change list, and the head-written test list no longer apply to mutation coverage; they still apply where a repository audits with `static.mutation`.
- Its ledger record per round and static check keeps, for mutation, the IDs of the verification records relied on per changed line, and the adapter and installation identity, in place of the lines Stryker mutated and the test files it ran.
- Its sharing section's rule that the agent voids every mutation record from another Node runtime becomes: a record whose installation or adapter identity differs from the agent's is not evidence, and the agent verifies the mutants it then lacks records for.
- Its `review.coverage` record absorbs the `mutants` record this decision adds at adjudication, once both are built; until then the two records are written side by side and either leaves the review not reviewed.

Until the ledger lands, adjudication writes one check record of its own, `mutants`, from the enumeration and the records at the head, as `review.coverage` will. Under `mutants.evidence: required` it is `ran` when every mutant on a changed production line has a record at the head: killed, a survivor finding, or a dismissal. Otherwise it is `skipped` without leave, naming the count of unverified mutants and the command that verifies them, and the review is not reviewed. Under `advisory`, the default, it is `ran` with the counts in its notes. Melian writes it; nothing the head writes reaches it. Like `review.coverage`, it joins every manifest without a tier entry, and a `melian.yaml` naming it in a tier or in `checks.allowSkip` is refused when the file is read. Melian's own root `melian.yaml` sets `required`.

### 7. Customers **[Melian's flow]**

The three skills gain a section, "Prove the tests", for a builder agent: after writing code and tests, run `melian mutants list origin/main...HEAD --all --json` into a scratch file, classify every mutant with a claim, structured evidence and survivor classes, run `melian mutants sample` and verify its probes, then `melian mutants verify --all` before pushing, and relay what each prints. A claim is never written as held until `verify` says so. An `equivalent` claim is the user's to confirm; the review raises it as a finding for them to dismiss. The skills run only `melian`, as today, and `verify` is run only on the user's own branch at their word. `melian doctor` stays the one command without a trigger.

`melian doctor` gains a `mutants` line per configured language: the adapter, the enumerator's source and version, the checkout's or Melian's, the test runner and its version, and `mutants.evidence`. For a dedicated tool or grammar it says found or not found, and warns when a configured language has no tool. It runs none of them.

The customer reads `docs/design/mutation-evidence.md`, the skill section, and the `melian.yaml` keys in the core guideline's table: `mutants.evidence`, `mutants.languages`, `mutants.timeout`.

### 8. Building Melian **[Building Melian]**

Once this is built, `AGENTS.md` changes in these places. It is not edited now.

- Validation: "The `static.mutation` check runs this proof on the changed lines of every pull request in the `full` tier" becomes: the `tests` lens runs it with probes, and `melian mutants verify --all` runs it before a push. "A surviving mutant the check itself reports keeps its P2 severity" becomes: a survivor a probe or a verification shows keeps its P2 severity.
- Briefs: `node scripts/enumerate-mutants.mjs <base>...HEAD --json --limit 10000` becomes `melian mutants list <base>...HEAD --all --json`; `--sample <inventory.json>` becomes `melian mutants sample <inventory>`; "Run every selected probe" becomes `melian mutants verify <inventory>` for the sample and `--all` before the push. The sentence "The host's `static.mutation` remains the authority; enumeration runs no tests" becomes: the verification records are the authority, and `melian mutants list` runs no tests. The evidence field names a test file and name, not a string.
- Converging: "Run the mutation check on the fix commits before pushing them", with its `melian.local.yaml` and `--trust-head` recipe, becomes `melian mutants verify --all` on the fix commits' inventory. "Before a branch's first full round, run the mutation check alone on the host and kill or explain every survivor" goes. The Learnings entries that give that recipe stay as history, with one line added saying it no longer applies.
- Ready and queued: nothing names `--cold`, since Melian's tiers no longer run the check. The round script's `FINAL=1` cold run goes with it.
- Delegation: "A Codex task cannot run Stryker, because the seatbelt denies `ps`" becomes: a Codex task can run `melian mutants verify`, which spawns no process listing.

The root `melian.yaml` drops `static.mutation` from `full` and its `static.mutation` settings, and adds `mutants: { evidence: required }`. That is a policy change the build pull request's review will notice.

## What this gives up

- Exhaustiveness on every round. Stryker ran every mutant against its related tests; a round now runs the builder's records and up to 12 probes. A mutant nobody claimed and no lens probed is `unverified`, which `required` makes visible and blocking, and `advisory` only lists.
- A record is one test. Stryker's related run could show a mutant killed by a test the builder never thought of; a record shows only what was asked. The `survived` outcome of a probe without a named test still runs the related tests, so a lens's probe is as broad as Stryker's per-mutant run.
- The whole-suite fallback. Stryker fell back to every test when it related none; a probe without a related test reports `survived` with the note that no test relates, and the finding says so.
- Writer trust still covers a faked kill and a hand-written record, as it covers Stryker's staged report today.
- Minutes per head for `verify --all`, measured above, on the builder's machine rather than the host's.
- A second verification executor to keep in step with the LLM one: the same record shape, a third `executor` value, and one more kind of evidence the verifier reads.

## For the attack

Trust and blocking rules, numbered for the attacker. Each is to be broken as written.

1. A kill is a test that passes unmutated and fails mutated, at the exact head the record names. `invalid`, `timeout` and a failing baseline are never `killed`.
2. A verification record is evidence at its own head only. A review at `H` reads records at `H`, with its own installation and adapter identity, and only when the review itself has leave to run `H`.
3. Verification and probes run head code under [the unconfined decision](2026-10-14-static-checks-run-unconfined.md)'s leave: a writer's head in the base repository, or `--trust-head`. The one addition is `melian mutants verify`, which is the user's word for the inventory's head and records leave `reviewer`. A review without leave runs no probe.
4. An `untested-behaviour` report names a probed mutant whose record reads `survived`; one naming a killed mutant is refused; one naming none is refused while a probe is available, and otherwise goes to the verifier as today.
5. A `survived` record confirms a finding's mechanism; the verifier may lower it one step within the fence and may not refute it. A refutation by the `probe` executor supplies no trust-floor minimum; a verifier's refutation keeps the floor.
6. `budget.probes` bounds a lens run's probes, `mutants.timeout` bounds each, and a refused probe is recorded on the lens's record. An exhausted probe budget does not end the lens.
7. `mutants.languages` and its test commands come from the committed root `melian.yaml`, read from the base for a pull request; a nested or preference file that sets them is refused.
8. The `mutants` check record is written by Melian at adjudication from the enumeration and the records; nothing the head writes reaches it. It joins every manifest without a tier entry, and a `melian.yaml` naming it in a tier or `checks.allowSkip` is refused. Under `required`, an unverified mutant on a changed production line leaves the review not reviewed.
9. The enumerator runs no head code: it reads blobs through git and instruments in an empty scratch directory. The instrumenter is the checkout's or Melian's, never a file in the revision's tree, and the record names its version.
10. A mutant's identity is the SHA-256 of `[file, line, column, endLine, endColumn, mutatorName, replacement]`; sampling and records key on it, and a row without end coordinates is refused.
11. `static.mutation`, where a repository enables it, keeps every rule of [mutation reruns, as built](2026-10-16-mutation-reruns-later-changes.md). Melian's own tiers no longer name it.
12. A dismissal of a survivor finding carries across heads by its trigger hash, as any dismissal does; it is the only way an `equivalent` claim stops counting.
