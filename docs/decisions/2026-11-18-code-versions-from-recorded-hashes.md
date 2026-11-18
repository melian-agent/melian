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

The adjudication attach key, `adjudicationKey`, is the task's input in canonical JSON, core's `canonicalJson`, with `code` set to `codeVersion("adjudication")` beside the input's fields. The review and the dismissal both call it. The input stays readable from the key, as the dismissal, compare and publish read it.

## What a stored head costs

A key stored before this change is main's bare `JSON.stringify` of the input, with no `code`, so it never matches. Each stored head decides again once, on the first review after the upgrade. Adjudication calls no model, and the lens tasks attach as before, so this spends no tokens. `packages/pipeline/test/adjudication-key-reopen.test.ts` reopens a store main's own code wrote and shows it.

## The layout keeps parallel pull requests apart

Most open pull requests touch the pipeline, so most will change some recorded line. A blank line parts every entry, so git merges two pull requests that change different modules, neighbours in path order included, without a conflict. Example: pull request A edits `review.ts` and pull request B edits `rounds.ts`. Each regenerates the file, changing one hash line each; the lines are a blank line apart, so the second to land merges cleanly. `scripts/code-hashes.test.mjs` shows this with `git merge-file`.

Two pull requests that each add a new module into the same gap in path order still conflict, since git cannot order two insertions at one place. That needs two new files that sort next to each other with nothing recorded between them, which is rare. The second to land merges `main`, runs `npm run code-hashes`, and commits the result.

## What it gives up

A change to an installed package that decides a verdict, such as a Pi Durable release, does not move the code version. The lockfile pins those packages, and keying the whole install would decide every head again on any reinstall. Any change to a reached module moves it, a comment or a test-only export included, which decides stored heads again needlessly; that costs no model call.

## What follows

[Issue #437](https://github.com/melian-agent/melian/issues/437) adds the checks, the verifier, the walkthrough and the decider as producers in the same file and gate test, and replaces the checks' hand-raised numbers. Adjudication's `version: 7` stays: it versions the task's stored shape, which a migration still needs.
