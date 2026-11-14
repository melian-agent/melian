# Issue and pull request text is written simply, for a reader with no context

The maintainer ruled on 2026-11-14, in the coordinator's session: any issue or pull request text must be expressed simply, for a human audience, with no assumed context.

## The problem

Builders, the coordinator and the reviews all post on issues and pull requests, and the maintainer reads them to rule, to read findings, and to review a milestone. A comment written from inside the work reads as a list of finding IDs, commit hashes and labels its author coined, such as "fixed df97a160 per option A". A reader who was not in that session has to open three links to learn what changed.

[The coordinator-first decision](2026-11-13-builders-ask-the-coordinator-first.md) already holds a question to this standard. This extends it to everything posted.

## The rule

- Every issue and pull request text, the title, the description and each comment, is written simply, for a human reader who has none of the author's context.
- It says in plain words what it does and why, before any detail.
- It names a thing by what it does, with a link. A finding's ID, a commit hash or a coined label may follow that description, never stand in for it.

## What this costs

Posts get a sentence or two longer. An ID alone was quicker to write, and only its author could read it.
