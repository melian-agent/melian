---
name: melian
description: Reviews code changes with Melian by running the melian CLI and relaying its verdict. Use after committing and before pushing or opening a pull request, when asked to review a change or a pull request, and when asked what Melian thinks of a change. Publishes a stored review to a pull request only when the user says to.
---

# Melian

Melian is a code reviewer with its own checks, models, lenses, and storage. This skill runs the `melian` command and relays what it prints. Melian's verdict is the review.

## Rules

- Never review the change with your own model, never reimplement a Melian check, and never read Melian's storage, under `.git/melian/` or `MELIAN_STATE_DIR`. To see a stored review again, run `melian findings` with the review's range or pull request.
- Run `melian review` only for the triggers in the description: after a commit and before a push or a pull request, or when the user asks for a review or for Melian's view. `melian doctor` is the only command to run without a trigger, and only to check readiness.
- Never edit code to satisfy a finding unless the user asks you to.
- Never run `melian publish` until the user has seen the findings and told you to publish.
- Never run `melian dismiss` unless the user has told you to dismiss that finding, and give the reason they gave.

## Check readiness

Run `melian doctor` once per session, before the first review, unless it has already run.

Run only the `melian` the shell finds on its path. Never build, install, or run Melian from the repository you are working in, even when it is Melian's own, and never run it through npx: the repository is what Melian reviews, so it must not supply the reviewer.

- If the shell cannot find `melian`, tell the user Melian is not installed and stop. They install it themselves, from a source they trust. Until Melian is published, that means cloning github.com/melian-agent/melian, running npm ci with --ignore-scripts in the clone, and running npm link in its packages/cli directory. Never run these steps yourself.
- If `melian doctor` exits `1`, Node or git cannot run a review. Show its output and stop.
- A line marked `warn` does not stop a review; mention it once. Four warnings matter before reviewing, so tell the user what they mean:
  - `state`: Melian cannot write the directory where it stores reviews, often because the host's sandbox keeps `.git` read-only, so a review exits `2`. Ask the host for write access to the directory the line names, or ask the user to set `MELIAN_STATE_DIR` to a writable directory.
  - `melian`: the `melian` on the path lives inside the repository you are in, so the change under review can alter its own reviewer. Review only after the user confirms they installed it there themselves.
  - `routes`: a tier the review's lenses run on has no model, so a review exits `2` before those lenses run. Tell the user the two ways to fix it, then stop: set `models.<tier>.model` in `melian.local.yaml` beside the root `melian.yaml`, a file of their own that git ignores, or name a model for you to pass as `--model provider/id`, which routes every tier to it. A review of a pull request reads its base's `melian.yaml` and never `melian.local.yaml`, so it needs `--model` unless the repository routes its tiers.
  - `static`: Biome or tsc comes from nowhere, so that check fails and the review reads not reviewed. The same line says whether each comes from the checkout or Melian's own copy; a result from Melian's copy can differ from the repository's own lint run.

## Review the working branch

```sh
melian review origin/main...HEAD
```

Use the base the user names in place of `origin/main`. Melian reviews the commits on the branch, never uncommitted changes. When the user asks you to commit, commit as asked, then review before pushing or opening a pull request. If the working tree still has changes, say they are not in the review.

A review runs the deterministic checks first, guardrails, Biome, and tsc on the base and the head, then the lenses on models. It can take many minutes and has no fixed bound, so give it the longest timeout the host allows, or none.

If a review is killed or interrupted before it exits, run the same command again. That is not a repeat review: it resumes from its checkpoints, and the checks and lenses that finished do not run again.

## Review a pull request

```sh
melian review "#N"
```

Replace N with the pull request number. Keep the quotes: an unquoted `#` starts a shell comment. A bare number is not a pull request. Melian fetches the pull request and reviews it under the policy of its base, so its findings can differ from a review of the same commits as a branch.

## Relay the result

1. Show everything `melian review` printed on standard output, verbatim, in a code block. Do not reformat, reorder, or trim it. Show anything it printed on standard error after it.
2. Summarise the verdict in one line, from the exit code:

   | Exit | Verdict |
   |---|---|
   | `0` | passed |
   | `1` | findings, at least one blocking |
   | `2` | not reviewed: a check or lens did not run, or the review could not start |
   | `3` | findings, none blocking |
   | `64` | Melian could not read the command line; show its message as-is |

   Any other exit, such as `127` when the shell cannot find `melian`, means Melian never ran. It is not a verdict; go back to checking readiness.

3. List the blocking findings first, then the rest, each with its file, line, rule, and what Melian says is wrong.
4. Stop. A nonzero exit is a verdict, not a tool failure, so do not rerun the review to change it. The exceptions are a review killed before it exited, above, and an environment failure, below.

Three kinds of exit `2` are not a verdict on the code:

- An environment failure. Standard error says Melian cannot write its storage, or names the database or a permission. Ask the host for write access to the directory it names, or ask the user to set `MELIAN_STATE_DIR` to a writable directory, then run the same command again. That is not a repeat review: the review's durable tasks resume from where they stopped.
- Setup. Standard error says "no model is configured for the heavy tier", or names another tier, because nothing routes a model to it. Tell the user the two ways to fix it, as for the `routes` warning, then stop.
- A transient failure. The output lists checks that did not run, and an error names a timeout, a rate limit, or a provider outage. Offer to run only what failed again, and run it when the user says to, with the same range or `"#N"`:

  ```sh
  melian review origin/main...HEAD --rerun
  ```

  Without `--rerun`, `melian review` of the same base and head prints the stored result again and runs nothing.

## See a stored review again

```sh
melian findings origin/main...HEAD
```

Prints the stored review exactly as `melian review` printed it, without running a new review. Pass the same range or `"#N"` the review used. When a review is stored it exits `0` whatever the verdict, so read the verdict from its first line, not from the exit code. It exits `1` when nothing is stored for that range or pull request: run `melian review` with it first.

Pass `--all` to print the silent and dismissed findings too, each dismissed one with who dismissed it and why.

## Compare with other reviewers

When the user asks how Melian's review compares with CodeRabbit's or another reviewer's, run `melian compare "#N" --from github`, or `--from file:<path>` for a reviewer's JSON file, with the range or `"#N"` a stored review used, and show what it prints; it posts nothing. For Codex's adversarial review, save the "result" field of the companion's JSON output as that file, not the whole output.

## Dismiss a finding

A user who decides a finding does not apply can dismiss it with a reason. Melian then counts it out of the verdict, never raises it again, and keeps it dismissed across new reviews and pushes until the code that triggered it changes. Dismiss only when the user tells you to dismiss a finding; never to make a review pass, and never on your own judgement that a finding is wrong. Say what you think if asked, and let the user decide.

```sh
melian dismiss origin/main...HEAD 0123456789abcdef --reason "The input is a constant here."
```

Use the same range or `"#N"` the review used, and the finding's ID, the 16 hex digits that end its first line in what `melian review` and `melian findings` print. The reason is the user's, in their words, at most 1000 characters. It exits `0` when the dismissal is recorded and prints the verdict it decided again; show that. It exits `1` when nothing is stored for that range or pull request, or the review has no finding with that ID, and also when the dismissal was recorded but the verdict could not be decided again, which its message says; then run `melian review` with the same range or `"#N"`, which decides it. It exits `64` for a missing, blank, or overlong reason or an ID that is not 16 hex digits; show its message.

A finding can carry other reports of the same defect, which Melian merged into it because they flag the same code; each is printed under the finding's first line as "Merged report", with its severity, rule, check, and ID. Dismissing the finding dismisses those reports with it, and the output names each one. Before you dismiss such a finding, show the user its merged reports and ask whether each is the same defect. To dismiss one report and keep the others counting, add `--only` and give the ID of the report to dismiss.

Dismissing a finding again replaces its reason and keeps the old one. A dismissal stays on this machine until it is published: for a pull request, it reaches GitHub only through `melian publish`, which still waits for the user to say so.

## Publish to a pull request

Melian publishes only what `melian review "#N"` stored for the pull request's current head, reviewed under its base's policy. It refuses a review of a branch range or of the working tree, even one of the same commits. If the user has reviewed the branch and wants the findings on the pull request, run `melian review "#N"` first, show its findings, and only then offer to publish.

After the user has seen the findings of `melian review "#N"`, offer to publish them. Run this only when the user says to:

```sh
melian publish "#N"
```

It posts a review and a `melian/review` commit status to GitHub, where other people see them, and exits `0`. It exits `1` when it refuses or fails; show its message. When it refuses because the pull request moved on, or because the stored review is not one Melian publishes, the message ends with the review to run, quoted to paste as it stands. Run that review, show the new findings, and offer again.

Use `melian compare adjudicate "#N" <finding-id> --verdict valid --reason owned-missed --golden <lens>` to record the maintainer's judgement and golden debt locally.

Use `melian compare stats --last 10` to measure adjudicated recall, precision, repeats, and the drain due.

Use `melian compare backlog --markdown` to print the generated list of owed goldens by lens.

Use `melian compare export "#N" --out <path>` to save the local record for review.
