# GitHub guidelines

The github package implements core's `ReviewProvider` port for GitHub through Octokit, renders what a review posts, and reads Melian's markers back. The pipeline's publish task decides when to post and records each post; this package decides how a post looks and where GitHub puts it. [design.md](../design.md#cli) says why the CLI sets a commit status rather than a check run.

## Posting

- One review per revision, with the event `COMMENT`. Never `APPROVE` or `REQUEST_CHANGES`: Melian never approves, and the status, not the review, says whether a change may merge.
- Inline comments go on the right-hand side by `line`, with `start_line` for a span, never by the deprecated diff `position`. Core's `placeFinding` only ever names an added line, because GitHub refuses the whole review with a 422 when one comment names a line outside the diff.
- A finding outside the diff in a changed file is anchored to the nearest added line, and its comment links to the finding's lines at the revision with `blobUrl`. A finding in a file the change does not touch goes in the review body under a marker of its own.
- An `affected` finding's evidence is a location, so its comment links to the changed lines that break it, at the revision, rather than quoting text.
- `createReview` does not return its comments' IDs, so `postReview` lists the review's comments afterwards and reads each one's finding from its marker.
- The commit status context is `melian/review`. GitHub refuses a description over 140 characters, so `setStatus` truncates.

## Markers

Every post opens with a hidden marker on a line of its own: `<!-- melian:revision=<sha> <kind>=<id> sig=<signature> -->`. The kind is `finding` on a finding's comment and on each finding in a review's body, `verdict` on a review's body, and `resolved` on a reply that resolves a finding. The ID is the finding's, or for `verdict` the fingerprint of the verdict the review posts, because a second review of one head can change its verdict, and the publication of the new verdict is a review of its own. The signature is the first 32 hex digits of HMAC-SHA256, keyed with the changeset's publisher secret, over `<sha>|<kind>=<id>`; [the pipeline guideline](pipeline.md#publishing) says where the secret lives.

`findPublished` lists the pull request's reviews and review comments and counts a marker only when its signature verifies against the secret, whoever posted it. Problem: markers were trusted by author alone, and the author came from `/user`, which an installation token cannot read. Example: a run posted a review, crashed before recording it, and the rerun, with a fresh provider that had never seen a post, could not tell who it was, read no markers, and posted the review a second time. Solution: the signature is the proof, and the author is a filter. When the provider knows the token's user, from `/user` or from a review it posted, a marker on anyone else's post does not count either; when it does not, the signature alone decides. A marker without a valid signature never counts, so a pull request's author cannot forge one to hide Melian's review. Anyone can copy a signed marker from a post, but the copy names only what Melian already posted, and the signature covers the kind, so a thread's marker pasted into a reply does not read as a resolution. The first post carrying a marker wins, since a copy can only follow Melian's own. The publish task reads markers before posting, so a run that crashed after GitHub accepted a post and before the task recorded it finds that post instead of repeating it. GitHub takes no idempotency key, so the markers are the only record GitHub itself keeps.

Untrusted text must never forge a marker, even though a forged one now fails its signature. Problem: a lens writes finding text after reading a change its author controls, and the author also chooses file paths. Example: an explanation holding a copied `<!-- melian:revision=<next head> verdict=<fingerprint> sig=<signature> -->` on a line of its own would make the next revision's publication think its review was already posted, and post nothing. Solution: `prose` escapes `<`, `>`, and `&` in every piece of finding text, so no HTML survives; `code` shows control characters in paths and rule IDs as `\uXXXX`, so a path cannot start a line; and only a marker standing alone on a line counts. `prose` also puts a zero-width space after `@`, so a lens cannot mention, and notify, anyone. Any new rendering of finding text goes through `prose` or `code`.

## Tokens

`resolveGitHubToken` reads `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`. Report where a token came from, never the token. `GitHubError` messages carry GitHub's status and message only; Octokit redacts the token from the request it attaches to its own error, and that error is never printed.

## Tests

- Answer Octokit with the fake in `test/fixtures/fake-github.ts`, passed as `fetch`. It records every call, applies writes to a plain state object, and refuses an inline comment outside the diff as GitHub does. Never call the network.
- `test/fixtures/scenario.ts` builds a pull request in two revisions and reviews it on the fake model, so publication tests run against a real verdict and findings document.
- The crash test, `test/publish-crash.test.ts`, runs `test/fixtures/publish-crash.ts` in a child process that parks once the fake has accepted the review, kills it, and publishes again in the test process. The child writes the fake's state to a file after every write, so the post outlives the process. It runs once with `/user` answering and once with it refusing, as for an installation token, so recovery never leans on knowing the author.
