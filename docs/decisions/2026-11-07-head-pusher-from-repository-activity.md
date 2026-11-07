# A head's pusher comes from the repository's activity

Status: built for [issue #301](https://github.com/melian-agent/melian/issues/301). The maintainer ruled in the builder's session that the author fallback is retired everywhere.

Amends: [Trusted writer requires a base-repository head](2026-10-12-trusted-writer-requires-base-repository-head.md), its events-API paragraph and its author fallback.

## Problem

The GitHub provider decided whose code a pull request's head is from the repository's events feed. The feed is the wrong authority. It lags by hours: on 2026-11-07 its newest `PushEvent` was more than six hours old, while builders pushed many times in between. It keeps only the latest 300 events, which this repository fills in about a day and a half. So a head a writer pushed minutes ago had no matching event, and the provider fell back to the pull request's author, whose permission says nothing about who pushed the head.

## Choice

The provider reads `GET /repos/{owner}/{repo}/activity` for the head's branch, `ref=refs/heads/<branch>`, newest first, a hundred entries a page. GitHub records each `push`, `force_push` and `branch_creation` there with its `actor` and `after` commit, with no lag. The newest entry of those three kinds whose `after` is the exact head on the exact ref names the pusher, and the CLI checks that login's permission. Paging stops at that entry. A branch deletion or a merge never names a pusher.

The head is refused, with the reason recorded, when:

- no entry names the head;
- the matching entry has no actor;
- the activity cannot be read.

The activity endpoint needs a token with `contents: read`; the events feed needed only metadata. GitHub's `X-Accepted-GitHub-Permissions` header on the endpoint reads `contents=read`. So a fine-grained token now needs `contents: read` beside `pull_requests: write` and `statuses: write`, and a token without it refuses every head, with a reason that names the permission.

## The author fallback

The author fallback is gone. The CLI's `writerTrust` takes the provider's pusher alone, and a provider that names none refuses the head, whatever the author's permission. The fallback existed because the events feed often had no matching event; the activity API has no such gap, so the fallback would only let an author's permission stand in for a pusher no one could name. The [Actions-rounds decision](2026-11-06-actions-rounds-run-default-branch-code.md) already ruled it out for the `melian round` workflow, and [pull request #299](https://github.com/melian-agent/melian/pull/299) moves that workflow's gate to the same API.

A known pusher without write permission still never yields to anyone else's permission.
