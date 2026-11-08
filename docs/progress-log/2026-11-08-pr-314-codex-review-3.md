[Pull request #314](https://github.com/melian-agent/melian/pull/314), fixes for Codex's adversarial review of a0756fc. It was the second round in a row to find `publish` acting on state it did not hold for certain, so the class went to the maintainer, who ruled that the storage be stored before posting.

- `publishReview` takes `beforePosting`, run once the publisher secret and target are committed and before the first post. `publish` uses it to push the copy to `melian/state` and keep the lease, through `ChangesetStore.checkpoint`, so a clone that takes the pull request over holds the secret that signed what GitHub holds. A checkpoint that cannot store posts nothing.
- A final push that the branch refused, or could not take, let `publish` exit 0 with the branch behind GitHub. An authoritative store now fails its command then, keeping the copy.
- A clone with SQLite storage from before the state branch published past the lease, over a newer round another clone kept on the branch. It now refuses when `melian/state` holds the pull request, and when it cannot read the branch to say, through `StateBranch.stored`, which needs no key.

`StateCheckout.push` takes `keepLease`, which refreshes the lease's heartbeat. The hook's tests failed first with its call removed; the CLI's checkpoint, final-push and legacy tests failed first on a0756fc.
