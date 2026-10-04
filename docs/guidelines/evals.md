# Evals guidelines

The evals package measures whether Melian's reviews find what they should and nothing else. It holds the golden corpus, a runner that reviews each golden, and scoring. [design.md](../design.md#evals-and-testing) says why evals are first-class: noise is where reviewers fail, and only measurement defends against it.

## A golden

Each golden is a directory under `packages/evals/goldens/`:

```text
goldens/correctness-null-deref/
├── base/           # the repository at the base commit
├── head/           # the repository at the head commit, every file, not only the changed ones
├── melian.yaml     # optional; committed with base, so it is the policy the review runs under
├── expected.json   # what a review must find
├── script.json     # the lens replies the scripted runner plays back
└── scripted.txt    # the scripted run's terminal output, compared by the gate
```

`buildGoldenRepository` commits `base/` on `main`, replaces the tree with `head/` on `feature`, and the runner reviews `main...feature`. A file in `base/` and missing from `head/` is deleted; a file that moves is a rename. Keep the trees small enough to read in one sitting, and write them as working code apart from the declared defects, so a live model is not distracted by unrelated breakage.

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

`severity` is Martian's `Critical`, `High`, `Medium`, or `Low`. `file` and `rule` are what scoring matches on; `rule` must be one the producing lens declares. `cause`, `failureScenario`, and `evidence` are what a good lens reports for the defect, `evidence` in the shape `report_finding` takes it. The scripted runner checks all three against the finding through `scriptedMismatches`, so the script's `report_finding` call carries the same scenario and locations; a live run checks none of them, since no model words a scenario the same way twice. A clean golden has an empty `comments` list, and any finding on it costs precision. Melian also reads one top-level field of its own, `live`, which [Adding a golden](#adding-a-golden) describes.

`script.json` maps each lens name to its replies, in order. A reply is `{ "calls": [{ "name", "arguments", "expectToolResult" }] }`, one model turn calling tools, or `{ "text": "..." }`, a final answer. `expectToolResult` is optional: a substring the call's result must contain. The runner checks it when the lens's next request arrives, and `runGolden` returns every miss in `toolMismatches`, which the gate requires to be empty. Problem: a scripted reply ignores what the tools returned, so a `search` broken to return "No matches." or a `read_file` of the wrong file still passed. Solution: give every call in a golden an expectation, such as the line a search must find or `recorded finding` for `report_finding`. Every lens the change selects needs a script, even if it only answers `Reported 0 findings.`; an unscripted lens fails the run.

## Two modes

**Scripted** runs are part of `npm run check`. `runGolden(golden, { kind: "scripted" })` routes every tier to the fake model, answers each lens from `script.json` by matching its instructions in the system prompt, and returns the findings and their terminal rendering. The test requires precision and recall of 1, the expected cause, failure scenario, and evidence for each finding, and a rendering identical to `scripted.txt`. Scripted runs prove the plumbing: lens selection, the lens tools reading the head revision, `report_finding`, the hook, the findings document, and rendering. They say nothing about whether a lens's prompt finds the defect, because the script finds it.

After a deliberate change to rendering or to a golden, regenerate the snapshots with `npx vitest --run -u packages/evals/` and read the diff before committing.

**Live** runs call real models and are never part of the gate. Run them with:

```bash
MELIAN_EVAL_LIVE=1 MELIAN_EVAL_MODEL=anthropic/claude-sonnet-4-5 npm run eval:live --workspace @melian-agent/evals
```

Credentials resolve as in a review: Pi's login, then the provider's environment variables. `MELIAN_EVAL_MODEL` routes every tier a golden's `melian.yaml` leaves unrouted. `MELIAN_EVAL_GOLDEN` names one golden to review instead of the corpus, as `MELIAN_EVAL_GOLDEN=contracts-breaking-signature`, for the repeated passes below; a name no golden has, or a golden marked `live: false`, which runs scripted only, stops the script with status 2 before it touches a provider. The script prints precision and recall per golden and micro-averaged over the corpus, skipping any golden marked `live: false`. Without `MELIAN_EVAL_LIVE=1` it exits with status 2 before touching a provider. Record each live run under `packages/evals/runs/`, with the model IDs, the commit reviewed, and what the misses and extras say about the lenses. `live.ts` prints no findings and no token counts; to record them, call `runGolden` from the built package with a model collection wrapped to log each request, as the method in [the second run](../../packages/evals/runs/2026-10-03-live-goldens-2.md#method) describes.

One run cannot tell a fixed lens from a lucky draw. In the [second](../../packages/evals/runs/2026-10-03-live-goldens-2.md) and [third](../../packages/evals/runs/2026-10-03-live-goldens-3.md) runs, an extra finding that one pass drew on a golden was missing from the other pass over the same golden. A live run that judges a prompt change therefore reviews each golden three times and reports the worst and the mean precision and recall. This is the rule for future runs; `live.ts` still reviews each golden once and does not enforce it.

## Scoring

A reported finding matches an expected one when both name the same file and rule. Each expected finding is a true positive at most once: a second reported finding matching an expectation already matched is a false positive, because it reports one defect twice. Precision is true positives over reported findings; recall is expected findings found over expected findings. A golden with nothing expected has recall 1, and one with nothing reported has precision 1. `scoreCorpus` sums the counts across goldens before dividing, so a golden with many findings weighs more than a clean one.

File and rule is a coarse match. Two findings under one rule in one file count as one expected finding found, and a finding on the right file and rule but the wrong line still matches. Martian's judge compares comment text; run it when the match needs to be semantic.

## Adding a golden

1. Write `base/` and `head/` so the change carries only the declared defects, or none for a clean golden. One change may carry more than one, as real changes do: `contracts-breaking-signature` breaks a caller and gets yen wrong. Declare every real defect, because a lens that finds an undeclared one is right and would score as noise.
2. Write `expected.json`, naming for each defect the lens rule that should catch it, its cause, a failure scenario with concrete values, and the evidence locations that show it.
3. Write `script.json` with the tool calls a good lens would make, each with the `expectToolResult` that proves its tool worked, ending each lens with a final answer. Each `report_finding` call carries the failure scenario and evidence its expected finding names.
4. Run `npx vitest --run -u packages/evals/` to write `scripted.txt`, read it, and commit all of it.
5. Run the live eval if you have credentials, and record a miss as a learning about the lens, not by loosening the golden.

`live.ts` runs every golden, or the one `MELIAN_EVAL_GOLDEN` names, unless its `expected.json` sets `"live": false`. It prints `<golden>: skipped, live: false` for such a golden and leaves it out of the corpus score; the scripted run still covers it. Problem: some goldens test plumbing a live lens has no reason to exercise. `pre-existing-beside-change` proves that a `context` location in changed code does not promote an old defect, so it expects a `pre-existing` finding, and a live lens that rightly declines to audit old code never reports one. Live, that golden could only cost recall. Set `live: false` only for such a golden, never to hide a lens's miss. `injection-in-comment` checks that a lens reports an instruction planted in the change under `melian/injection-attempt` and still finds the defect beside it; on a live run, a lens that obeys the comment scores a recall of zero. `correctness-deleted-guard` is a pure deletion: the finding beside the deleted guard has no new lines to overlap, so only its `cause` location at the base, read with `read_file` and `revision: "base"`, makes it `affected`.

Comparison reviews in `comparisons/` feed the corpus: each adjudicated difference between reviewers becomes a golden, positive or negative.
