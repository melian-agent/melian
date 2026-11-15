# Pull request #309: golden trees hold what they name

Builder agent: [pull request #309](https://github.com/melian-agent/melian/pull/309) now has every golden's tree hold each file its modules import and its workflows run.

## The finding

Codex's adversarial review at `d85b9ad2` raised one medium finding. The coordinator ran it on the host against `origin/main`.

The clean round-leak golden's `melian-round.yml` runs `scripts/round-writer.mjs`, and the tree doesn't hold it. Neither twin does. A probing golden now scores the whole review. So a lens that rightly reports the missing helper costs the clean twin precision, though its `expected.json` lists nothing. The scripted probe calls `round-comment.mjs` directly, so it never hit the gap.

## The class, checked across the corpus

This is the same class as the round's P0 at `1197dc27`. Once a golden scores the whole review, every lens reads the whole tree. A clean golden must then give none of them a reason to report.

A scan of every relative import in every golden tree, base and head, found misses only in the round-leak pair. A read of every workflow's `node` commands found the same. Per golden:

- **Round-leak pair, both twins:**
  - the workflow runs three helpers the tree lacked: `round-writer.mjs`, `round-codex-token.mjs` and `round-own-comment.mjs`;
  - it runs Melian's CLI, `packages/cli/bin/melian.js`, and runs `npm ci` with no `package.json`;
  - core's `render.ts` and `emoji.ts` import types from `adjudication.ts`, `config.ts`, `findings.ts` and `verification.ts`, which the tree lacked;
  - `emoji.ts` links to a guideline the tree lacked.
- **Claim pair:** nothing missing. `claim.yml` runs inline `github-script`, and names AGENTS.md only in a comment.
- **Syntax-check pair:** nothing missing. `syntax-check.mjs` imports Node's built-ins alone.
- **The other 89 goldens:** nothing missing.

## The fix

- **Helpers.** Both twins' heads hold the three helpers as `fc0d1755` has them. Their imports match both twins' `round.mjs`.
- **Core.** `render.ts` is now an excerpt of the four functions `round.mjs` uses: `visibleText`, `plural`, `describeBudgetEnd` and `describeLineage`. It declares their two types inline. `emoji.ts` is gone. Base and head change alike, so the review's diff is unchanged.
- **The CLI.** A tree can't hold Melian's CLI. The round job checks it out from `melian-agent/melian` at `fc0d1755`, pinned, and runs `npm ci` there. The repository's own scripts still come from the default branch's checkout, so both measured leak paths stand. The defect head's raw verdict still goes to the uploaded directory, and its `round.mjs` still prints each check's error. The defect's expectations, both scripts and the defect's snapshot move with the seven inserted lines.
- **The test.** `holds every file a golden's modules import and its workflows run`, in `goldens.test.ts`, covers the whole corpus.
  - Vite's parser lists each module's relative imports, type-only ones included.
  - For workflows, the test reads `node <relative path>` in each step's `run:`, from its `working-directory`, and skips a checkout of another repository. Any other shape after `node` fails the test.
  - The shell part is a re-derivation, and the test's comment says so.

## The failing run

At `d85b9ad2`, with the test added and the fixtures unchanged:

```
AssertionError: expected [ …(32) ] to deeply equal []
+   "trust-boundary-probe-round-environ-leak-clean/head/.github/workflows/melian-round.yml: scripts/round-writer.mjs",
+   "trust-boundary-probe-round-environ-leak-clean/head/.github/workflows/melian-round.yml: scripts/round-codex-token.mjs",
+   "trust-boundary-probe-round-environ-leak-clean/head/.github/workflows/melian-round.yml: packages/cli/bin/melian.js",
+   "trust-boundary-probe-round-environ-leak-clean/head/.github/workflows/melian-round.yml: scripts/round-own-comment.mjs",
+   "trust-boundary-probe-round-environ-leak-clean/head/packages/core/src/render.ts: packages/core/src/adjudication.ts",
…
Tests  1 failed | 137 skipped (138)
```

Across both twins, the 32 misses were:
- `melian.js`: 6;
- `config.ts`: 8;
- `adjudication.ts`, `findings.ts` and `verification.ts`: 4 each;
- each of the three helpers: 2.

## The passing run

After the fix, the test passed. The whole of `goldens.test.ts` passed too: 138 of 138. The clean twin's scripted finding is still refused because its probe passes ("did not fail, so it shows no defect"). The new evidence lines don't cause the refusal.

## The clean twin, read as the other lenses would

- **Correctness.** Every command now names a file in the tree, or one in the pinned CLI checkout. `../melian-cli` from `working-directory: melian` resolves to the second checkout's path under the workspace.
- **Contracts.** The helpers call `headWriter`, `codexAccessToken` and `ownComment` with the arguments `round.mjs` declares.
- **Removed behaviour.** The diff removes nothing, because base and head change alike in core.
- **Conventions.** The trees carry no standards file.
- **Durability.** Nothing is stored.
- **Design.** The only new choice is the pinned CLI. It runs a reviewed commit with the logins, as the original runs the default branch's commit.
- **Tests.** No test covers the scripts. That holds for 28 of the corpus's 30 clean goldens, and this pull request doesn't change it. [Issue #356](https://github.com/melian-agent/melian/issues/356) records it as a risk to read the measurement's scores against.

I found nothing one of them should rightly report.

No trust or durability code changed. The changes are fixtures, a test and this entry.
