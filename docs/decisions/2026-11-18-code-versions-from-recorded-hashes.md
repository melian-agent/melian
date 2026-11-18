# A producer's code version comes from recorded module hashes

Status: ruled by the maintainer on 2026-11-16, in the coordinator's session, on [issue #437](https://github.com/melian-agent/melian/issues/437#issuecomment-6906681894). Built first for adjudication by [issue #578](https://github.com/melian-agent/melian/issues/578), whose layout the coordinator approved on 2026-11-18, in its session.

## Problem

A stored result is reused when its key matches, and a key holds the result's inputs, not the code that turns them into the result. Example: a release fixes adjudication so a finding that used to pass now blocks. A maintainer reviews a head the old build passed. The inputs match, so Melian prints the old pass, and keeps printing it until a new head or `--rerun`. Only `version: 7` on the adjudication task moves with that code, and only when someone remembers to raise it; even then a stored task migrates rather than deciding again.

A number raised by hand fails two ways. A change that forgets it reuses a stale answer, which nobody sees. Two parallel pull requests that both remember it raise it to the same next number for different changes, and conflict on the line.

## The ruling

Record hashes, not numbers. The maintainer's principle, ruled with it: Melian relies on hashes, not manual version bumps, wherever it can.

- `packages/pipeline/src/code-hashes.ts` holds one line per module a producer's run reaches, its path and the SHA-256 of its bytes, and each producer's list of those paths. `scripts/code-hashes.mjs` writes it, run as `npm run code-hashes`.
- A producer's code version, `codeVersion(producer)`, is a SHA-256 over its own modules' recorded lines, in path order. It reads the recorded file, never source at run time, since [identity rule 8](../guidelines/identity.md#rules) forbids hashing source text and the published tarball ships no `src/`.
- The gate's `scripts/code-hashes.test.mjs` fails when a module's text changed without its line, or when a producer's reached set changed without its list. It names the producer, the module and the command.

## How it is built

TypeScript decides what a producer reaches. The native compiler ships no program API, so the generator asks its command line, `tsc --listFilesOnly`, for the files the producer's entry module reaches under the gate's own configuration and the `@melian-agent/source` condition, which resolves workspace imports to source. Installed packages are left out, since the lockfile pins them; so is the recorded file itself, whose hash would depend on itself. Adjudication's entry is `packages/pipeline/src/adjudication.ts`, which reaches 114 modules in core, pipeline and decisions.

The adjudication task's input carries `code`, set to `codeVersion("adjudication")` by the build that creates the task. The attach key, `adjudicationKey`, is that input in canonical JSON, core's `canonicalJson`. The review and the dismissal both call it, and the dismissal sets its own build's `code` on the input it reuses. The input stays readable from the key, as the dismissal, compare and publish read it.

## A build decides only its own tasks

Builds share a store, so one can resume a task another created. Example: a review under build A creates an adjudication task, and the process dies before the task decides. Build B, with a changed decider, opens the store and resumes the task. Without a check, B writes its verdict into the round under A's key, and A's next review attaches to a verdict A's code never made.

So the task records the code that may decide it, and its phase fails when `task.input.code` differs from the running build's `codeVersion("adjudication")`, with the reason "another build's adjudication code created this task, so this build decides nothing; run melian review again to decide it here". A failed adjudication is always decided again on the next review, which creates a task under the running build's code. The task is version 8, so a build before this change, which cannot check `code`, refuses to run a version 8 task at all. A version 7 task migrates with `code` unset, so it fails under every build and never attaches. `packages/pipeline/test/adjudication-key-reopen.test.ts` reopens a task main left pending, fails it, and decides the revision again on the next review; `review.test.ts` fails a task whose `code` names another build.

## What a stored head costs

A key stored before this change is main's bare `JSON.stringify` of the input, with no `code`, so it never matches. Each stored head decides again once, on the first review after the upgrade, and a task main left pending fails rather than decides. Adjudication calls no model, and the lens tasks attach as before, so this spends no tokens. `packages/pipeline/test/adjudication-key-reopen.test.ts` reopens a store main's own code wrote and shows it.

## The layout keeps parallel pull requests apart

Most open pull requests touch the pipeline, so most will change some recorded line. A blank line parts every entry, so git merges two pull requests that change different modules, neighbours in path order included, without a conflict. Example: pull request A edits `review.ts` and pull request B edits `rounds.ts`. Each regenerates the file, changing one hash line each; the lines are a blank line apart, so the second to land merges cleanly. `scripts/code-hashes.test.mjs` shows this with `git merge-file`.

Two pull requests that each add a new module into the same gap in path order still conflict, since git cannot order two insertions at one place. That needs two new files that sort next to each other with nothing recorded between them, which is rare. The second to land merges `main`, runs `npm run code-hashes`, and commits the result.

## What it gives up

A change to an installed package that decides a verdict, such as a Pi Durable release, does not move the code version. The lockfile pins those packages, and keying the whole install would decide every head again on any reinstall. Any change to a reached module moves it, a comment or a test-only export included, which decides stored heads again needlessly; that costs no model call.

## What follows

[Issue #437](https://github.com/melian-agent/melian/issues/437) adds the checks, the verifier, the walkthrough and the decider as producers in the same file and gate test, and replaces the checks' hand-raised numbers. Adjudication's task version stays: it versions the task's stored shape, which a migration still needs, and version 8 is the shape that carries `code`.
