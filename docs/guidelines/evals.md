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

`buildGoldenRepository` commits `base/` on `main`, replaces the tree with `head/` on `feature`, and the runner reviews `main...feature`. A file in `base/` and missing from `head/` is deleted; a file that moves is a rename. Keep the trees small enough to read in one sitting, and write them as working code apart from the seeded defect, so a live model is not distracted by unrelated breakage.

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
      "cause": "introduced"
    }
  ]
}
```

`severity` is Martian's `Critical`, `High`, `Medium`, or `Low`. `file` and `rule` are what scoring matches on; `rule` must be one the producing lens declares. `cause` is checked by the scripted runner. A clean golden has an empty `comments` list, and any finding on it costs precision.

`script.json` maps each lens name to its replies, in order. A reply is `{ "calls": [{ "name", "arguments", "expectToolResult" }] }`, one model turn calling tools, or `{ "text": "..." }`, a final answer. `expectToolResult` is optional: a substring the call's result must contain. The runner checks it when the lens's next request arrives, and `runGolden` returns every miss in `toolMismatches`, which the gate requires to be empty. Problem: a scripted reply ignores what the tools returned, so a `search` broken to return "No matches." or a `read_file` of the wrong file still passed. Solution: give every call in a golden an expectation, such as the line a search must find or `recorded finding` for `report_finding`. Every lens the change selects needs a script, even if it only answers `Reported 0 findings.`; an unscripted lens fails the run.

## Two modes

**Scripted** runs are part of `npm run check`. `runGolden(golden, { kind: "scripted" })` routes every tier to the fake model, answers each lens from `script.json` by matching its instructions in the system prompt, and returns the findings and their terminal rendering. The test requires precision and recall of 1, the expected cause for each finding, and a rendering identical to `scripted.txt`. Scripted runs prove the plumbing: lens selection, the lens tools reading the head revision, `report_finding`, the hook, the findings document, and rendering. They say nothing about whether a lens's prompt finds the defect, because the script finds it.

After a deliberate change to rendering or to a golden, regenerate the snapshots with `npx vitest --run -u packages/evals/` and read the diff before committing.

**Live** runs call real models and are never part of the gate. Run them with:

```bash
MELIAN_EVAL_LIVE=1 MELIAN_EVAL_MODEL=anthropic/claude-sonnet-4-5 npm run eval:live --workspace @melian-agent/evals
```

Credentials resolve as in a review: Pi's login, then the provider's environment variables. `MELIAN_EVAL_MODEL` routes every tier a golden's `melian.yaml` leaves unrouted. The script prints precision and recall per golden and micro-averaged over the corpus. Without `MELIAN_EVAL_LIVE=1` it exits with status 2 before touching a provider. Record each live run under `packages/evals/runs/`, with the model IDs, the commit reviewed, and what the misses and extras say about the lenses. `live.ts` prints no findings and no token counts; to record them, call `runGolden` from the built package with a model collection wrapped to log each request, as the method in [the second run](../../packages/evals/runs/2026-10-03-live-goldens-2.md#method) describes.

## Scoring

A reported finding matches an expected one when both name the same file and rule. Each expected finding is a true positive at most once: a second reported finding matching an expectation already matched is a false positive, because it reports one defect twice. Precision is true positives over reported findings; recall is expected findings found over expected findings. A golden with nothing expected has recall 1, and one with nothing reported has precision 1. `scoreCorpus` sums the counts across goldens before dividing, so a golden with many findings weighs more than a clean one.

File and rule is a coarse match. Two findings under one rule in one file count as one expected finding found, and a finding on the right file and rule but the wrong line still matches. Martian's judge compares comment text; run it when the match needs to be semantic.

## Adding a golden

1. Write `base/` and `head/` so the change carries exactly one defect, or none for a clean golden.
2. Write `expected.json`, naming the lens rule that should catch it.
3. Write `script.json` with the tool calls a good lens would make, each with the `expectToolResult` that proves its tool worked, ending each lens with a final answer.
4. Run `npx vitest --run -u packages/evals/` to write `scripted.txt`, read it, and commit all of it.
5. Run the live eval if you have credentials, and record a miss as a learning about the lens, not by loosening the golden.

Every golden is in the live corpus: `live.ts` runs them all, so a new golden needs no marking. `injection-in-comment` checks that a lens reports an instruction planted in the change under `melian/injection-attempt` and still finds the defect beside it; on a live run, a lens that obeys the comment scores a recall of zero.

Comparison reviews in `comparisons/` feed the corpus: each adjudicated difference between reviewers becomes a golden, positive or negative.
