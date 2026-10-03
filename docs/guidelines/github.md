# GitHub guidelines

The github package implements core's `ReviewProvider` port for GitHub through Octokit, renders what a review posts, and reads Melian's markers back. The pipeline's publish task decides when to post and records each post; this package decides how a post looks and where GitHub puts it. [design.md](../design.md#cli) says why the CLI sets a commit status rather than a check run.

## Posting

- One review per revision, with the event `COMMENT`. Never `APPROVE` or `REQUEST_CHANGES`: Melian never approves, and the status, not the review, says whether a change may merge.
- Inline comments go on the right-hand side by `line`, with `start_line` for a span, never by the deprecated diff `position`. Core's `placeFinding` only ever names an added line, because GitHub refuses the whole review with a 422 when one comment names a line outside the diff.
- A finding outside the diff in a changed file is anchored to the nearest added line, and its comment links to the finding's lines at the revision with `blobUrl`. A finding in a file the change does not touch goes in the review body under a marker of its own.
- `createReview` does not return its comments' IDs, so `postReview` lists the review's comments afterwards and reads each one's finding from its marker.
- The commit status context is `melian/review`. GitHub refuses a description over 140 characters, so `setStatus` truncates.

## Markers

Every post opens with a hidden marker on a line of its own: `<!-- melian:revision=<sha> finding=<id> -->` on a comment or a reply, `<!-- melian:revision=<sha> verdict=<fingerprint> -->` on a review's body. The fingerprint names the verdict the review posts, because a second review of one head can change its verdict, and the publication of the new verdict is a review of its own. `findPublished` lists the pull request's reviews and review comments and reads the markers on posts by the token's own user. It learns that user from `/user`, or from the author of a review it posted, and when it cannot, it reads no markers at all: an installation token cannot read `/user`, and counting every author's markers would let a pull request's author post a forged one and hide Melian's review. The publish task reads them before posting, so a run that crashed after GitHub accepted a post and before the task recorded it finds that post instead of repeating it. GitHub takes no idempotency key, so the markers are the only record GitHub itself keeps.

Untrusted text must never forge a marker. Problem: a lens writes finding text after reading a change its author controls, and the author also chooses file paths. Example: an explanation holding `<!-- melian:revision=<next head> verdict=<fingerprint> -->` on a line of its own would make the next revision's publication think its review was already posted, and post nothing. Solution: `prose` escapes `<`, `>`, and `&` in every piece of finding text, so no HTML survives; `code` shows control characters in paths and rule IDs as `\uXXXX`, so a path cannot start a line; and only a marker standing alone on a line counts. `prose` also puts a zero-width space after `@`, so a lens cannot mention, and notify, anyone. Any new rendering of finding text goes through `prose` or `code`.

## Tokens

`resolveGitHubToken` reads `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`. Report where a token came from, never the token. `GitHubError` messages carry GitHub's status and message only; Octokit redacts the token from the request it attaches to its own error, and that error is never printed.

## Tests

- Answer Octokit with the fake in `test/fixtures/fake-github.ts`, passed as `fetch`. It records every call, applies writes to a plain state object, and refuses an inline comment outside the diff as GitHub does. Never call the network.
- `test/fixtures/scenario.ts` builds a pull request in two revisions and reviews it on the fake model, so publication tests run against a real verdict and findings document.
- The crash test, `test/publish-crash.test.ts`, runs `test/fixtures/publish-crash.ts` in a child process that parks once the fake has accepted the review, kills it, and publishes again in the test process. The child writes the fake's state to a file after every write, so the post outlives the process.
