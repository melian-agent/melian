# A reviewer, not the sampler, judges a suite claim's file

Amends: [suite assertions proved per case](2026-11-14-suite-assertions-proved-per-case.md), who checks that a suite claim's file is a shared suite

The coordinator chose this on 2026-11-14, as its answer on approach on [issue #406](https://github.com/melian-agent/melian/issues/406). It is not a maintainer's ruling.

## The problem

[The suite-assertions decision](2026-11-14-suite-assertions-proved-per-case.md) lets a builder skip running a mutant only in a test suite that a package keeps under its source folder for other packages to import. An inventory row names only a file, and nothing in the row says whether that file is such a suite. So a `suite` claim on production code would excuse a guard from its proof.

[Pull request #409](https://github.com/melian-agent/melian/pull/409) first had the sampler decide by reading the nearest `package.json` at the inventory's head, and accept a claim only in the file its `./testing` export names. Four review passes each found the check disagreeing with what Node resolves. Example: Node reads an export target as a URL, so `./src/testing.ts?case/production.ts` loads `src/testing.ts`, while the check read another file from git. Vitest also loads an export map Node refuses: a condition key such as `"1.5"`. No hand-written resolver can be trusted to match both. Asking Node instead would mean writing the head's files onto the reviewer's machine and running a process over them.

## The rule

- The sampler reads no file to judge a `suite` claim. It accepts one in any file of a version-2 inventory, so long as the claim gives a reason.
- `--sample` lists every `suite` row apart from the probes, grouped by file and ordered by line, with its reason.
- The review of record checks, for each `suite` row the sample prints, that its file is a test suite kept under a source folder for other packages to import, and that a deleted-assertion row names a proved neighbour. A `suite` row in production code is a P2 finding.
- A legacy inventory that holds a `suite` claim is still refused when it parses.

## What this gives up

The tool no longer refuses a `suite` claim on production code; a reviewer does. A review of record that skips the check lets such a claim stand.
