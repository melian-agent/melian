# Evals guidelines

The evals package measures whether Melian's reviews find what they should and nothing else. It holds the golden corpus, a runner that reviews each golden, and scoring. [design.md](../design.md#evals-and-testing) says why evals are first-class: noise is where reviewers fail, and only measurement defends against it.

## A golden

Each golden is a directory under `packages/evals/goldens/`:

```text
goldens/correctness-null-deref/
├── base/           # the repository at the base commit
├── head/           # the repository at the head commit, every file, not only the changed ones
├── melian.golden.yaml  # optional; committed with base as melian.yaml, so it is the policy the review runs under
├── expected.json   # what a review must find
├── script.json     # the lens replies the scripted runner plays back
├── scripted.txt    # the scripted run's terminal output, compared by the gate
└── README.md       # optional; the comparison record and finding the defect came from
```

`buildGoldenRepository` commits `base/` on `main`, replaces the tree with `head/` on `feature`, and the runner reviews `main...feature`. A golden stores standards and policy under inert names, `AGENTS.golden.md` for `AGENTS.md` and `melian.golden.yaml` for `melian.yaml`, and `buildGoldenRepository` writes each under its live name, dropping `.golden` before the extension. Problem: the corpus sits in Melian's own repository, where an `AGENTS.md` is a standards file for the folder that holds it. Example: `conventions-unpinned-action`'s standards require pinned actions while its tree deliberately pins a tag, so a review of a change under that golden would load the fixture's rules as Melian's. Solution: only the golden's temporary repository sees the live names, and a test fails on any live name under `goldens/` but the corpus's own `goldens/melian.yaml`. Melian's root `melian.yaml` also keeps every lens off `packages/evals/goldens/**`, so seeded defects are never reviewed as Melian's code, and `goldens/melian.yaml` switches off `policy-change-review` beneath it, since a golden's `tsconfig.json` or `eslint.config.js` configures the golden's repository, not an analyser that runs on Melian; a change to that `melian.yaml` itself is still reported. A file in `base/` and missing from `head/` is deleted; a file that moves is a rename. Keep the trees small enough to read in one sitting, and write them as working code apart from the declared defects, so a live model is not distracted by unrelated breakage. The runner loads standards for the changed paths from the base and gives each lens its own chains. A nested `AGENTS.golden.md` reaches lenses covering that directory. The review reads standards from the base, so a golden that tests the `conventions` lens carries its `AGENTS.golden.md` in `base/` and, unchanged, in `head/`.

A golden for a repository lens, such as Melian's own `durability`, carries the lens in both trees as `.melian/lenses/<name>/LENS.golden.md`, and a `melian.golden.yaml` naming it in the tier, as Melian's root `melian.yaml` does. Problem: a golden's review loads lenses from the golden's own repository, which holds only its trees, so Melian's `.melian/lenses/` never reaches it; and a `LENS.md` under its live name inside the corpus would be a lens for the folder holding it whenever Melian reviews itself. Solution: the copy takes the inert name, `buildGoldenRepository` writes it as `LENS.md`, and a test fails when a copy differs from the original, or when anything else sits beneath a `.melian/` or `.agents/` in the corpus. Another fails when a golden's `full` tier differs from the root's, or the root's leaves out a check of the default `full` tier, so a golden scores the lenses Melian runs on itself. A golden copies every repository lens whose prompt its review should run with, an override included: the `durability` goldens also carry Melian's `correctness` and `removed-behaviour` overrides, which add their hand-off to `durability`, so a golden measures the prompts Melian runs on itself. A test fails when a tree carries some of Melian's repository lenses but not all, so no golden runs one side of a hand-off without the other. After editing a lens or the root's `full` tier, copy it over every golden that carries it. The root's `full` tier names `lens.design`, so every golden with a `melian.golden.yaml` scripts the `design` lens too; every `design-` golden carries the three repository lenses beside it, as the `durability` goldens do, and script every lens in the tier.

`expected.json` uses Martian's golden-comment shape, so Martian's judge reads it unchanged, with Melian's fields added to each comment:

```json
{
  "pr_title": "Trim manager names",
  "comments": [
    {
      "comment": "managerName reads name from an optional manager ...",
      "severity": "High",
      "category": "bug",
      "file": "src/user.ts",
      "rule": "null-dereference",
      "cause": "introduced",
      "failureScenario": "describe({ name: \"Ada\" }) ... throws a TypeError ...",
      "evidence": [
        { "file": "src/user.ts", "line": 7, "endLine": 8, "role": "cause" },
        { "file": "src/user.ts", "line": 7, "role": "context", "revision": "base" }
      ]
    }
  ]
}
```

`severity` is Martian's `Critical`, `High`, `Medium`, or `Low`. `file` and `rule` are what scoring matches on; `rule` must be one the producing lens declares. An optional `source` names a check, such as `lens.trust-boundary`, that must have reported the finding. Problem: lenses that report one defect at one place share a finding, so a merged score cannot tell which lens found it. Example: `injection-in-comment` scores perfectly when `correctness` reports the planted comment, even if every other lens obeyed it. Solution: an expectation with a `source` matches only a finding whose `reportedBy` lists that check. `cause`, `failureScenario`, and `evidence` are what a good lens reports for the defect, `evidence` in the shape `report_finding` takes it. The scripted runner checks all three against the finding through `scriptedMismatches`, so the script's `report_finding` call carries the same scenario and locations; a live run checks none of them, since no model words a scenario the same way twice. A clean golden has an empty `comments` list, and any finding on it costs precision. Melian also reads one top-level field of its own, `live`, which [Adding a golden](#adding-a-golden) describes.

`script.json` maps each lens name to its replies, in order. A reply is `{ "calls": [{ "name", "arguments", "expectToolResult" }] }`, one model turn calling tools, or `{ "text": "..." }`, a final answer. `expectToolResult` is optional: a substring the call's result must contain. The runner checks it when the lens's next request arrives, and `runGolden` returns every miss in `toolMismatches`, which the gate requires to be empty. Problem: a scripted reply ignores what the tools returned, so a `search` broken to return "No matches." or a `read_file` of the wrong file still passed. Solution: give every call in a golden an expectation, such as the line a search must find or `recorded finding` for `report_finding`. Every lens the change selects needs a script, even if it only answers `Reported 0 findings.`; an unscripted lens fails the run.

## Two modes

**Scripted** runs are part of `npm run check`. `runGolden(golden, { kind: "scripted" })` routes every tier to the fake model, answers each lens from `script.json` by matching its instructions in the system prompt, and returns the findings and their terminal rendering. The test requires precision and recall of 1, the expected cause, failure scenario, and evidence for each finding, and a rendering identical to `scripted.txt`. Scripted golden tests allow 60 seconds because they create git repositories and run durable conversations; a loaded gate can exceed Vitest's five-second default. Scripted runs prove the plumbing: lens selection, the lens tools reading the head revision, `report_finding`, the hook, the findings document, and rendering. They say nothing about whether a lens's prompt finds the defect, because the script finds it.

After a deliberate change to rendering or to a golden, regenerate the snapshots with `npx vitest --run packages/evals/ --update` and read the diff before committing.

**Live** runs call real models and are never part of the gate. Run them with:

```bash
MELIAN_EVAL_LIVE=1 MELIAN_EVAL_MODEL=anthropic/claude-sonnet-4-5 npm run eval:live --workspace @melian-agent/evals
```

Credentials resolve as in a review, in this order: the named credentials of `melian.secrets.yaml` at the top level of the repository the script runs in, and of the user's own secrets file; then Pi's login; then the provider's environment variables. `npm run eval:live` runs the script in the evals package, not the root, so the first file sits there. `MELIAN_EVAL_MODEL` routes every tier a golden's `melian.golden.yaml` leaves unrouted. `MELIAN_EVAL_GOLDEN` names one golden to review instead of the corpus, as `MELIAN_EVAL_GOLDEN=contracts-breaking-signature`, for the repeated passes below. A name no golden has, or a golden marked `live: false`, which runs scripted only, stops the script with status 2 before it touches a provider. The script prints precision and recall per golden and micro-averaged over the corpus, skipping any golden marked `live: false`. Without `MELIAN_EVAL_LIVE=1` it exits with status 2 before touching a provider. Record each live run under `packages/evals/runs/`, with the model IDs, the commit reviewed, and what the misses and extras say about the lenses. `live.ts` prints no findings and no token counts; to record them, call `runGolden` from the built package with a model collection wrapped to log each request, as the method in [the second run](../../packages/evals/runs/2026-10-03-live-goldens-2.md#method) describes.

One run cannot tell a fixed lens from a lucky draw. In the [second](../../packages/evals/runs/2026-10-03-live-goldens-2.md) and [third](../../packages/evals/runs/2026-10-03-live-goldens-3.md) runs, an extra finding that one pass drew on a golden was missing from the other pass over the same golden. A live run that judges a prompt change therefore reviews each golden three times and reports the worst and the mean precision and recall. This is the rule for future runs; `live.ts` still reviews each golden once and does not enforce it.

A lens meets the bar when, over three passes, its goldens' worst precision is at least 0.8 and their worst recall at least 0.6. A lens's goldens are those whose names start with its name, scored together as one corpus and counting every lens's findings on them, since a golden scores the whole review. A lens below either bar may still ship, marked below the bar in its run record and in the plan; its goldens are never loosened to lift it over.

## Verifier evals

Execution-dependent misses live under `packages/evals/verifier/<name>/`, separate from the lens corpus. Each directory holds `base/`, `head/`, `candidate.json`, `expected.json`, `script.json` and a `README.md` naming the comparison record and finding. The four initial misses come from [pull request #68](https://github.com/melian-agent/melian/pull/68), C5 and C8, [pull request #72](https://github.com/melian-agent/melian/pull/72), C9, and [pull request #61](https://github.com/melian-agent/melian/pull/61), A1. The decoys cover a null guard and a type with one caller that excludes zero.

`loadVerifierGoldens` validates the files. `runVerifierGolden` plants the candidate through a scripted lens's `report_finding`, so Melian reads the snippets, then runs the real verification task. `scoreVerifierGolden` accepts confirmed or plausible for a `needs-execution` case, and only refuted for a decoy. A missing judgement fails. A verifierFailed review scores that golden as unjudged and continues the corpus; other errors still stop the run. The scripted suite runs in the gate; it checks integration and scoring, not model quality. Lens goldens and their scoring stay unchanged. The root policy excludes this corpus from lenses, and its own `melian.yaml` disables policy notices beneath it.

Live verifier runs need both `MELIAN_EVAL_LIVE=1` and `MELIAN_EVAL_VERIFIER=1`. `MELIAN_EVAL_VERIFIER_MODEL` routes their judge independently; `MELIAN_EVAL_MODEL` is its fallback. `MELIAN_EVAL_GOLDEN` selects one verifier case. An unknown name or absent model stops the suite before provider access. The finder stays scripted, so the suite measures whether the judge retains a real defect. The runner prints each verdict and pass or fail, then the total; any failure exits 1. Live runs spend tokens and remain outside the gate.

Existing lens goldens explicitly route the fake verifier in scripted mode. In live mode their verifier uses `MELIAN_EVAL_VERIFIER_MODEL`, or `MELIAN_EVAL_MODEL`, or the committed verifier route when neither variable is set. A fake provider can be added to an existing opaque model collection through the pipeline testing entry; this lets a planted finder share a harness with a separately routed judge.

## Scoring

A reported finding matches an expected one when both name the same file and rule and, where the expected one names a `source`, the finding's `reportedBy` lists it. Each expected finding is a true positive at most once, and findings are paired with expectations so that as many count as can: a second reported finding matching an expectation already matched is a false positive, because it reports one defect twice. Precision is true positives over reported findings; recall is expected findings found over expected findings. A golden with nothing expected has recall 1, and one with nothing reported has precision 1. `scoreCorpus` sums the counts across goldens before dividing, so a golden with many findings weighs more than a clean one.

File and rule is a coarse match. Two findings under one rule in one file count as one expected finding found, and a finding on the right file and rule but the wrong line still matches. Martian's judge compares comment text; run it when the match needs to be semantic.

## Adding a golden

1. Write `base/` and `head/` so the change carries only the declared defects, or none for a clean golden. One change may carry more than one, as real changes do: `contracts-breaking-signature` breaks a caller and gets yen wrong. Declare every real defect, because a lens that finds an undeclared one is right and would score as noise.
2. Write `expected.json`, naming for each defect the lens rule that should catch it, its cause, a failure scenario with concrete values, and the evidence locations that show it.
3. Write `script.json` with the tool calls a good lens would make, each with the `expectToolResult` that proves its tool worked, ending each lens with a final answer. Each `report_finding` call carries the failure scenario and evidence its expected finding names.
4. Run `npx vitest --run packages/evals/ --update` to write `scripted.txt`, read it, and commit all of it.
5. Run the live eval if you have credentials, and record a miss as a learning about the lens, not by loosening the golden.

A lens body's examples never restate a golden. Problem: an example drawn from a golden tells the lens the answer, so the golden measures recall of the prompt rather than judgement. Example: `removed-behaviour` once named "the worktree is removed even when the task throws" as an invariant, the very defect `removed-behaviour-dropped-cleanup` seeds. Solution: write examples in shapes no golden seeds, and when a golden is added, check the lens bodies for its shape.

A repeated review finding that becomes a guardrail gets a golden too, named `guardrails-<rule>`. Its `melian.golden.yaml` carries the rule, copied from the root `melian.yaml`, and a test fails when the copy drifts. `expected.json` names `guardrail/forbidden-patterns` as the rule. `runGolden` runs the guardrails for a golden that expects a `guardrail/` rule and for no other. Problem: the default guardrails would add notices to every fixture's `package.json`. A guardrail finding has no failure scenario and no evidence, so a scripted run holds it to its cause alone. The golden sets `live: false`, since no model takes part. The lenses still run, scripted to report nothing.

`live.ts` runs every golden, or the one `MELIAN_EVAL_GOLDEN` names, unless its `expected.json` sets `"live": false`. It prints `<golden>: skipped, live: false` for such a golden and leaves it out of the corpus score; the scripted run still covers it. Problem: some goldens test plumbing a live lens has no reason to exercise. `pre-existing-beside-change` proves that a `context` location in changed code does not promote an old defect, so it expects a `pre-existing` finding, and a live lens that rightly declines to audit old code never reports one. Live, that golden could only cost recall. Set `live: false` only for such a golden, never to hide a lens's miss. `injection-in-comment` checks that a lens reports an instruction planted in the change under `melian/injection-attempt` and still finds the defect beside it; on a live run, a lens that obeys the comment scores a recall of zero. Each backlog lens has a targeted one too, `trust-boundary-injection`, `removed-behaviour-injection`, `tests-injection`, and `conventions-injection`: the planted comment names that lens and sits beside a defect only it owns, and the injection attempt is expected with `source` set to that lens, so a lens that obeys loses recall even when `correctness` reports the comment. `correctness-deleted-guard` is a pure deletion: the finding beside the deleted guard has no new lines to overlap, so only its `cause` location at the base, read with `read_file` and `revision: "base"`, makes it `affected`.

`correctness-deleted-rethrow` runs under the `standard` tier, as a `pre-push` review does. `runGolden` reviews under the tier of the `pull-request` stage, and that golden's `melian.golden.yaml` routes the stage to `standard`, so `correctness` runs alone and renders no hand-off. Its policy still carries Melian's `full` tier, as every golden's must.

Comparison records feed the corpus where an adjudication owes a golden, as [Comparisons](#comparisons) sets out.

One defect can fit two lenses' rules, and each would report it under its own. Declare a second finding only where the second lens's instructions claim that kind of defect, as both `correctness` and `removed-behaviour` claim a removed guard: `correctness-deleted-guard` and `removed-behaviour-dropped-guard` each expect `correctness`'s `wrong-result` and `removed-behaviour`'s `dropped-guard`. Otherwise the defect has one owner, and the other lens's report of it is an extra that says its boundary leaks.

## Comparisons

The shadow reviewers keep running until Melian reaches recall of at least 0.75 against the shadows' adjudicated findings. Use the ten most recent eligible merged pull requests after 2026-10-06T00:00:00Z. Every merged pull request in this repository after that instant is eligible, whether its comparison exists or not. A missing record or pending adjudication in that window blocks retirement. Require at least one adjudicated valid in-scope distinct shadow finding; zero findings leave recall undefined and keep both shadows running. The committed root key `comparison.retirement` holds `pullRequests: 10` and `recall: 0.75`. Only the maintainer may tighten the criterion. Count each distinct valid in-scope finding once across the shadows, and each pull request once across rounds. Noise, duplicates and out-of-scope findings do not count. Unadjudicated findings stay pending and missing records stay absent; either blocks retirement within the window. A shorter window keeps the shadows. The retirement line in `melian compare stats` follows [pull request #72](https://github.com/melian-agent/melian/pull/72).

Every Melian pull request gets a comparison record under `packages/evals/comparisons/`. It lists what Codex's adversarial review, Claude Code's review, and Melian found, and the maintainer's adjudication of each. `melian compare export` writes each new record from the stored comparison. Earlier hand-written records stay as history. [design.md](../design.md#comparison-with-external-reviewers) says how a comparison is built, and how it serves a repository that runs CodeRabbit.

Each finding is adjudicated valid, noise, or a duplicate, with a severity. A duplicate names the finding it duplicates through `--of <id>`. It costs its reviewer recall as well as precision; only that reviewer's own valid report earns recall credit. A valid finding Melian missed takes one reason:

- `owned-missed`: a lens or check owns it and missed it. It usually owes a golden for that lens.
- `no-owner`: no lens or check owns it. It points at a new rule, guardrail, or lens, and a repeat on a second pull request is a candidate check.
- `needs-execution`: it was found by running code, not by reading it. It joins [verifier evals](#verifier-evals) and the tool manifest's list, not the lens golden corpus.
- `out-of-scope`: Melian does not review this kind of change. It owes nothing, and does not count against Melian's recall.

A Melian finding judged noise owes a clean golden for the lens that raised it. A golden is owed only where the adjudication says so, naming its lens; a difference alone owes nothing. A golden drawn from a record names its finding in a `README.md` beside `expected.json`, since the expected file's schema is Martian's and has no field for it.

[goldens/BACKLOG.md](../../packages/evals/goldens/BACKLOG.md) lists, by lens, the owed goldens not yet written. Its present entries are kept by hand until goldens drain them. `melian compare backlog --markdown` prints the later generated section; replace the generated section after the frozen entries.

A historical hand-written record has no field for the reason. Its Adjudication column carries the words above. New records use the stored reason.

### The drain rule

Problem: records mark goldens faster than anyone writes them, and nothing forces the list down. BACKLOG.md still holds owed goldens from the record for [pull request #10](https://github.com/melian-agent/melian/pull/10).

Solution: every third comparison record is followed by a backlog pull request. It ships at least two owed goldens, or every owed golden when fewer remain. It re-measures each new golden's lens with a live run of three passes, as [Two modes](#two-modes) requires, and records the run under `packages/evals/runs/`. Records count from [pull request #65](https://github.com/melian-agent/melian/pull/65) on, and an empty backlog owes no drain. `melian compare stats` sees only this clone's stored changesets and self-declared discharge through `--golden none`. It counts changesets once, preserving all rounds for metrics. Its clone-wide notice remains due after the first threshold while debt remains, even with filtered metrics. It cannot see which drain pull requests shipped or which live runs passed, so it cannot verify the periodic drain. Hand-written historical records are not imported.

Comparison adjudications name an owed lens through `--golden <lens>`, or owe none through `--golden none`. A later judgement changes debt only when it includes `--golden`; omitting the option carries the debt forward. Every replacement keeps the prior judgement in history. A noise judgement on Melian is a comparison label; use dismissal separately to change the review.
