# First self-review, 2026-10-03

Melian's first review of its own unmerged work, run from a worktree of this repository through the built CLI on real models. It closes milestone 1: a Melian change reviewed by `melian review` against the branch. Nothing was published to GitHub.

## Run

- Command, from the worktree root after `npm run build`:

  ```sh
  node --env-file=<checkout>/.env packages/cli/bin/melian.js review origin/main...HEAD --model anthropic/claude-opus-5-5
  ```

  The `.env` file held `CLAUDE_CODE_OAUTH_TOKEN`, which the review models read when `ANTHROPIC_OAUTH_TOKEN` is unset. The flag keeps the credential off the command line.
- Head: `a21cb00850654d757f6a39fceb660c4149c151ea`, the `skill` branch for [issue #9](https://github.com/melian-agent/melian/issues/9), stacked on [pull request #19](https://github.com/melian-agent/melian/pull/19), [#16](https://github.com/melian-agent/melian/pull/16), and [#15](https://github.com/melian-agent/melian/pull/15).
- Base: `origin/main` at `684e1d8`. Another worktree fetched `origin/main` forward to `834a1cc`, the merge of [#15](https://github.com/melian-agent/melian/pull/15), 70 seconds after the review started; the reflog places the move after the range was resolved. The range held 60 commits and 117 files, 9,521 lines added.
- Policy source: the working tree, since the head was the checked-out commit. The repository had no `melian.yaml`, so `--model` routed every tier; both built-in lenses, `correctness` and `contracts`, are `heavy`.
- Wall clock: 7 minutes 26 seconds. Exit code `1`.

## Verdict

`findings, blocking`: one blocking finding and two to acknowledge.

| File | Lines | Rule | Severity | Cause | What |
| --- | --- | --- | --- | --- | --- |
| `skills/claude-code/SKILL.md` | 36-40 | `broken-caller` | P1, block | introduced | The skill runs `melian review origin/main...HEAD` without `--model`, so in a repository with no model routes, this one included, every review exits 2 with "no model is configured for the heavy tier". |
| `packages/pipeline/src/publish.ts` | 176-192 | `wrong-result` | P2, acknowledge | introduced | Replaying a pending round posts the round's findings under a body rendered from the current verdict, so a review whose verdict changed after a failed post contradicts itself. |
| `packages/pipeline/src/publish.ts` | 214-215 | `wrong-result` | P2, acknowledge | introduced | `Publication.resolved` counts every resolution recorded for the head, while its documentation and the other counts cover this run only. |

## Reading

All three findings are right.

The blocking finding is the most useful one Melian could have raised on this branch. The run itself proved it: without `--model` the skill's own command could not review this repository, which is why the command above carries the flag. It is fixed on the branch by a root `melian.yaml` that routes every tier, and by a line in the skill that reports an unrouted tier as setup rather than as a verdict. Its rule is a stretch, since `broken-caller` is a contracts rule about code and the caller here is prose, but the cause and severity fit: the change introduced both the skill and the call it makes. Its suggestion that `melian doctor` warn when no tier is routed is a good follow-up and is not done here.

The first `publish.ts` finding is real but narrow. It needs a post that failed after its round was planned, then a fresh review of the same head whose verdict differs, then another publish. Its second half matters more: a pending round clears only after a successful post, so a round GitHub keeps refusing blocks every later publish of that head. Both belong to [pull request #19](https://github.com/melian-agent/melian/pull/19).

The second `publish.ts` finding is a contract mismatch with a visible symptom: a repeated `melian publish` prints "0 new findings, 2 resolved". It also belongs to #19.

Three findings across 117 files is quiet. The lenses and adjudication code in the range had already been through comparison reviews, and Melian raised nothing there. No finding was a duplicate across the two lenses, the noise the [first live golden run](2026-10-03-live-goldens.md) measured.

One rendering detail: each finding prints its message, then repeats it word for word under `What:`. The lens report has no separate summary, so the terminal renderer shows the explanation twice.

## Output

```text
Verdict: findings, blocking

Block: 1 finding

skills/claude-code/SKILL.md

  P1  lines 36-40  broken-caller  (introduced, new)
  The skill tells the agent to run `melian review origin/main...HEAD` with no `--model`. The CLI only routes a tier when `--model` is given or a `melian.yaml` sets `models.<tier>`. The default config has `models: {}`, so `resolveModelForTier` throws `ModelRoutingError` `noModelForTier` for the built-in lenses' `heavy` tier. `main` turns that into exit 2 with "no model is configured for the heavy tier". This repository has no `melian.yaml`, so the self-review that `.claude/skills/melian` is meant to provide always comes back as not reviewed. The Codex and Pi skills make the same call.
    What: The skill tells the agent to run `melian review origin/main...HEAD` with no `--model`. The CLI only routes a tier when `--model` is given or a `melian.yaml` sets `models.<tier>`. The default config has `models: {}`, so `resolveModelForTier` throws `ModelRoutingError` `noModelForTier` for the built-in lenses' `heavy` tier. `main` turns that into exit 2 with "no model is configured for the heavy tier". This repository has no `melian.yaml`, so the self-review that `.claude/skills/melian` is meant to provide always comes back as not reviewed. The Codex and Pi skills make the same call.
    Why here: This change adds both the CLI's routing contract (packages/cli/src/models.ts routes tiers only when `model` is defined, and core's `resolveModelForTier` throws when a tier is unrouted) and the skills that call it without routing. In normal use, the documented skill workflow cannot produce a verdict anywhere models are not configured, including in Melian itself. The skill then tells the agent to treat exit 2 as a verdict and not to rerun.
    What to do: Pick one: give the CLI a default route for unrouted tiers, have the skills pass `--model` (or say in the skills that `melian.yaml` must set `models`), or commit a root `melian.yaml` with `models.heavy` so this repository can review itself. Have `melian doctor` warn when no tier is routed, so readiness catches it before a review does.

Acknowledge: 2 findings

packages/pipeline/src/publish.ts

  P2  lines 176-192  wrong-result  (introduced, new)
  When a pending round is replayed, `postReview` gets the round's findings and fingerprint (`pending.post`, `pending.verdict`) together with the verdict as it is now (`verdict`, read at line 161). `renderReviewBody` builds the status line, the counts and the list of checks that did not run from `draft.verdict`. If the verdict has changed since the round was planned, the posted review contradicts itself. The body describes the new verdict (for example `passed`, `No findings need attention`) while the inline comments and the body-placed findings come from the old one. The status set at line 219 also follows the new verdict.
    What: When a pending round is replayed, `postReview` gets the round's findings and fingerprint (`pending.post`, `pending.verdict`) together with the verdict as it is now (`verdict`, read at line 161). `renderReviewBody` builds the status line, the counts and the list of checks that did not run from `draft.verdict`. If the verdict has changed since the round was planned, the posted review contradicts itself. The body describes the new verdict (for example `passed`, `No findings need attention`) while the inline comments and the body-placed findings come from the old one. The status set at line 219 also follows the new verdict.
    Why here: This is reachable through the CLI. `melian publish '#12'` commits the pending round, then the provider call fails (for example a network error or a 5xx), so the task ends `failed` and the round stays pending. The user runs `melian review '#12'` again on the same head, a lens that failed now finishes, and the verdict changes. The next `melian publish '#12'` skips planning because `before.pending` is set (line 166) and posts the stale plan under the new verdict's body. A pending round is only cleared after a successful post. A round that GitHub keeps refusing, such as a 422 on one comment, therefore blocks every later publish of that head, even after a fresh review.
    What to do: Store what the body needs, the verdict or its fingerprinted copy, in `PendingRound`, and pass that stored verdict to `postReview` instead of the current one. Alternatively, when `pending.verdict !== current` and `findPublished` finds no review for the pending fingerprint, drop the pending round and replan it against the current verdict.

  P2  lines 214-215  wrong-result  (introduced, new)
  `result.resolved` is set to `Object.keys(record.resolved).length`, which counts every resolution ever recorded for this head across all runs. `posted`, `stillOpen` and `replies` count only this run. `Publication` is documented as "Counts cover this run; a second publish of one revision posts nothing".
    What: `result.resolved` is set to `Object.keys(record.resolved).length`, which counts every resolution ever recorded for this head across all runs. `posted`, `stillOpen` and `replies` count only this run. `Publication` is documented as "Counts cover this run; a second publish of one revision posts nothing".
    Why here: Take a head whose first publish resolved two findings. Publishing it again posts nothing, yet the CLI (`packages/cli/src/commands.ts`) prints `Published review …: 0 new findings, 2 resolved.` That tells the user two more findings were resolved by this run.
    What to do: Count only the resolutions this run added. Take the size of `pending.resolved` when a round was posted in this run, otherwise 0. Or document `resolved` as cumulative for the head and word the CLI message to match.

3 findings in 2 files.
```

## Fixed since

Recorded after [pull request #19](https://github.com/melian-agent/melian/pull/19) merged. All three findings are fixed.

- The P1 in `skills/claude-code/SKILL.md` was fixed on the `skill` branch, [pull request #21](https://github.com/melian-agent/melian/pull/21). `08d5f89` routes every lens tier in the root `melian.yaml`, and `f30792d` has the skill report an unrouted tier as setup rather than as a verdict. [#19](https://github.com/melian-agent/melian/pull/19) then made `melian doctor` warn when `melian.yaml` routes no tier, as the finding suggested, in `a7644b5`, and `54ffa39` has the skills read that warning before the first review.
- The first P2 was fixed in [#19](https://github.com/melian-agent/melian/pull/19) by `fa18dca`. A publish round keeps the verdict it renders, so a replayed round no longer posts its comments under the current verdict's body, and the third refusal of a round abandons it, so a round GitHub always refuses no longer blocks the head.
- The second P2 was fixed in [#19](https://github.com/melian-agent/melian/pull/19) by `5755eea`. `Publication.resolved` counts only this run's resolutions, as the other counts do, so a repeat publish no longer prints the head's earlier ones.
