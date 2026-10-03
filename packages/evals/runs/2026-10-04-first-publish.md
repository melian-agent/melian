# First publication, 2026-10-04

Melian's first review posted to a pull request through the CLI. The maintainer reviewed [pull request #28](https://github.com/melian-agent/melian/pull/28) with `melian review`, then posted it with `melian publish`. This closes milestone 1 of the [implementation plan](../../../docs/design-implementation-plan.md): the [first self-review](2026-10-03-first-self-review.md) ran the review but posted nothing.

## Run

- Checkout: the main checkout on `main` at `6a0bcc6`, with the CLI built.
- Review command:

  ```sh
  melian review "#28" --model anthropic/claude-opus-5-5
  ```

  The model's token came from the environment of that one process.
- Pull request: [#28](https://github.com/melian-agent/melian/pull/28), branch `class-convention`, the class-convention refactor. Head `7abf402608a036fa14e44528065dd94a36148651`, base `main` at `6a0bcc6`: 10 commits, 18 files, 526 lines added and 340 removed.
- Policy source: the base's committed policy, as for every pull request review. `--model` routed the lens tiers, since the base's `melian.yaml` routes none.
- Wall clock: 81 seconds, 23:34:24Z to 23:35:45Z UTC. Exit code `3`: findings, none blocking.
- Checks: every check ran, and `notRun` was empty. That is the guardrails, `static.biome`, `static.tsc`, `lens.correctness`, and `lens.contracts`.

## Verdict

`findings`: one finding to acknowledge, none blocking.

| File | Line | Rule | Severity | Cause | What |
| --- | --- | --- | --- | --- | --- |
| `AGENTS.md` | 1 | `guardrail/policy-change-review` | P2, acknowledge | introduced | The change edits `AGENTS.md`, which steers how Melian reviews this repository, and Melian reviewed it under the old policy, so a maintainer should read the change before merging. |

## Output

```text
Verdict: findings

Acknowledge: 1 finding

AGENTS.md

  P2  line 1  guardrail/policy-change-review  (introduced, new, acknowledge)
  Review policy and standards changed in this revision.
    What: This revision changes AGENTS.md, which steers how Melian reviews this repository.
    Why here: Melian reviewed the revision under the policy and standards it changes, so nothing it ran judged the new ones.
    What to do: Have a maintainer read the change to AGENTS.md before merging.

1 finding in 1 file.
```

## Publication

```sh
melian publish "#28"
```

Exit code `0`, printing:

```text
Published review 5403495555 of 7abf402608a0 to https://github.com/melian-agent/melian/pull/28: 1 new finding.
Status success: 1 finding, none blocking
```

The maintainer then read the pull request back through the GitHub API:

- One review, state `COMMENTED`, by the maintainer's account, on commit `7abf402`.
- Its body opens with the marker `<!-- melian:revision=<sha> verdict=8478a3dde3a3dade round=1 sig=<hex> -->`, then reads "Melian reviewed `7abf402608a0`: **findings**." and "1 finding need attention: 1 acknowledge."
- One inline comment, carrying its own marker, on `AGENTS.md` line 36. Line 1 is not in the diff, so the finding went to its nearest added line, as the [GitHub guideline](../../../docs/guidelines/github.md#posting) says it should.
- Commit status `melian/review`: success, "1 finding, none blocking".

## Idempotency

A second `melian publish "#28"` printed `0 new findings` and posted nothing. The pull request still had one review.

## Reading

The review was quiet, on point, and complete.

Pull request #28 is a behaviour-preserving refactor, and the lenses found nothing in it. The Codex and Opus reviews of [#28](https://github.com/melian-agent/melian/pull/28) found nothing either.

The one finding is right. The policy-change guardrail saw that the change edits `AGENTS.md`, which Melian reads as this repository's standards, and asked a maintainer to read it. Melian cannot judge a change to its own standards under those standards, so the guardrail is the only check that can raise it.

Every check ran, so the verdict covers the whole change. The marker, the nearest-line placement, the status, and the second publish that posted nothing all behaved as designed on GitHub itself, not only on the fake in the tests.

One wording fault: the body said "1 finding need attention", because the template did not make the verb agree with the count.
