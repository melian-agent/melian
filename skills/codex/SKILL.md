---
name: melian
description: Reviews code changes with Melian by running the melian CLI and relaying its verdict. Use before committing or opening a pull request, when asked to review a change or a pull request, and when asked what Melian thinks of a change. Publishes a stored review to a pull request only when the user says to.
---

# Melian

Melian is a code reviewer with its own checks, models, lenses, and storage. This skill runs the `melian` command and relays what it prints. Melian's verdict is the review.

## Rules

- Never review the change with your own model, never reimplement a Melian check, and never read Melian's storage under `.git/melian/`. To see a stored review again, run `melian findings` with the review's range or pull request.
- Run `melian review` only for the triggers in the description: before a commit or a pull request, or when the user asks for a review or for Melian's view. `melian doctor` is the only command to run without a trigger, and only to check readiness.
- Never edit code to satisfy a finding unless the user asks you to.
- Never run `melian publish` until the user has seen the findings and told you to publish.

## Check readiness

Run `melian doctor` once per session, before the first review, unless it has already run.

Run only the `melian` the shell finds on its path. Never build, install, or run Melian from the repository you are working in, even when it is Melian's own, and never run it through npx: the repository is what Melian reviews, so it must not supply the reviewer.

- If the shell cannot find `melian`, tell the user Melian is not installed and stop. They install it themselves, from a source they trust. Until Melian is published, that means cloning github.com/melian-agent/melian, running npm ci with --ignore-scripts and then npm run build in the clone, and running npm link in its packages/cli directory. Never run these steps yourself.
- If `melian doctor` exits `1`, Node or git cannot run a review. Show its output and stop.
- A line marked `warn` does not stop a review; mention it once. Three warnings matter before reviewing, so tell the user what they mean:
  - `melian`: the `melian` on the path lives inside the repository you are in, so the change under review can alter its own reviewer. Review only after the user confirms they installed it there themselves.
  - `routes`: `melian.yaml` routes no tier to a model, so a review exits `2` before any lens runs. Ask the user to set `models.<tier>.model` in `melian.yaml`, or to name a model you then pass as `--model provider/id`.
  - `static`: Biome or tsc comes from nowhere, so that check fails and the review reads not reviewed. The same line says whether each comes from the checkout or Melian's own copy; a result from Melian's copy can differ from the repository's own lint run.

## Review the working branch

```sh
melian review origin/main...HEAD
```

Use the base the user names in place of `origin/main`. Melian reviews the commits on the branch, never uncommitted changes. When the user asks you to commit, commit as asked, then review before pushing or opening a pull request. If the working tree still has changes, say they are not in the review.

A review runs the deterministic checks first, guardrails, Biome, and tsc on the base and the head, then the lenses on models. It can take several minutes: give the command at least ten minutes before any timeout.

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

3. List the blocking findings first, then the rest, each with its file, line, rule, and what Melian says is wrong.
4. Stop. A nonzero exit is a verdict, not a tool failure, so do not rerun the review to change it.

Two kinds of exit `2` are not a verdict on the code:

- Setup. Standard error says "no model is configured for the heavy tier", or names another tier, because no `melian.yaml` routes a model to it. Tell the user to set `models.<tier>.model` in `melian.yaml`, or to name a model you then pass as `--model provider/id`.
- A transient failure. The output lists checks that did not run, and an error names a timeout, a rate limit, or a provider outage. Offer to run only what failed again, and run it when the user says to, with the same range or `"#N"`:

  ```sh
  melian review origin/main...HEAD --rerun
  ```

  Without `--rerun`, `melian review` of the same base and head prints the stored result again and runs nothing.

## See a stored review again

```sh
melian findings origin/main...HEAD
```

Prints the stored review exactly as `melian review` printed it, without running a new review. Pass the same range or `"#N"` the review used. It exits `0` whatever the verdict, so read the verdict from its first line, not from the exit code.

## Publish to a pull request

Melian publishes only what `melian review "#N"` stored for the pull request's current head, reviewed under its base's policy. It refuses a review of a branch range or of the working tree, even one of the same commits. If the user has reviewed the branch and wants the findings on the pull request, run `melian review "#N"` first, show its findings, and only then offer to publish.

After the user has seen the findings of `melian review "#N"`, offer to publish them. Run this only when the user says to:

```sh
melian publish "#N"
```

It posts a review and a `melian/review` commit status to GitHub, where other people see them, and exits `0`. It exits `1` when it refuses or fails; show its message. When it refuses because the pull request moved on, or because the stored review is not one Melian publishes, the message ends with the review to run, quoted to paste as it stands. Run that review, show the new findings, and offer again.
