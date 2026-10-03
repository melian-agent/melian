---
name: melian
description: Reviews code changes with Melian by running the melian CLI and relaying its verdict. Use before committing or opening a pull request, when asked to review a change or a pull request, and when asked what Melian thinks of a change. Publishes a stored review to a pull request only when the user says to.
allowed-tools: Bash(melian doctor) Bash(npx melian doctor)
---

# Melian

Melian is a code reviewer with its own models, lenses, and storage. This skill runs the `melian` command and relays what it prints. Melian's verdict is the review.

## Rules

- Never review the change with your own model, never reimplement a Melian check, and never read Melian's storage under `.git/melian/`. To see a stored review again, run `melian findings`.
- Run `melian review` only for the triggers in the description: before a commit or a pull request, or when the user asks for a review or for Melian's view. `melian doctor` is the only command to run without a trigger, and only to check readiness.
- Never edit code to satisfy a finding unless the user asks you to.
- Never run `melian publish` until the user has seen the findings and told you to publish.

## Check readiness

Run `melian doctor` once per session, before the first review, unless it has already run.

- If the shell cannot find `melian`, and the working directory is a checkout of Melian itself, where `packages/cli/bin/melian.js` exists, run `npm run build` and use `npx melian` in place of `melian` for every command here. Never run `npx melian` anywhere else: npx would fetch an unrelated package named `melian` from the npm registry.
- If the shell cannot find `melian` anywhere else, tell the user how to install it, then stop:

  ```sh
  git clone https://github.com/melian-agent/melian.git
  cd melian
  npm ci --ignore-scripts && npm run build
  cd packages/cli && npm link
  ```

- If `melian doctor` exits `1`, Node or git cannot run a review. Show its output and stop. A line marked `warn` does not stop a review; mention it once.

## Review the working branch

```sh
melian review origin/main...HEAD
```

Use the base the user names in place of `origin/main`. Melian reviews the commits on the branch, never uncommitted changes, so if the working tree has changes, say they are not in the review. A review runs models and can take several minutes: run it with the Bash tool's `timeout` at 600000.

## Review a pull request

```sh
melian review "#N"
```

`N` is the pull request number. Keep the quotes: an unquoted `#` starts a shell comment. A bare number is not a pull request.

## Relay the result

1. Show everything `melian review` printed on standard output, verbatim, in a code block. Do not reformat, reorder, or trim it. Show anything it printed on standard error after it.
2. Summarise the verdict in one line, from the exit code:

   | Exit | Verdict |
   |---|---|
   | `0` | passed |
   | `1` | findings, at least one blocking |
   | `2` | not reviewed: a check did not finish, or the review could not start |
   | `3` | findings, none blocking |
   | `64` | Melian could not read the command line; show its message as-is |

3. List the blocking findings first, then the rest, each with its file, line, rule, and what Melian says is wrong.
4. Stop. A nonzero exit is a verdict, not a tool failure, so do not rerun the review to change it.

## See a stored review again

```sh
melian findings origin/main...HEAD --open
```

Prints the findings that still need attention, without running a new review. Pass the same range or `"#N"` the review used.

## Publish to a pull request

After the user has seen the findings of `melian review "#N"`, offer to publish them. Run this only when the user says to:

```sh
melian publish "#N"
```

It posts a review and a `melian/review` commit status to GitHub, where other people see them. If it refuses because the pull request has moved on, run `melian review "#N"` again and show the new findings before offering again. Melian never publishes a review of a branch range.
