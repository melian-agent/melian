# Main's version-8 publication recording

`published-v8-main.json` holds two published-document snapshots written by main at `36122eb2`.
The source came from `git archive 36122eb2`, installed with its own lockfile and left unchanged; only a recording test was added.
That test drove `publishReview` against `fakeGitHub` with fake models and memory storage.
It published an inline finding, a body-only finding and a protected trust-boundary claim with untrusted writers.
It then dismissed the first two and published again.
The `resolved` run refused the dismissal reply after the review posted; the `pending` run refused the review.
Each round's `state` is the snapshot verbatim, written as compact JSON.
The recorder was `pass6-record.test.ts` from pull request #145, pointed at an absolute output path.
