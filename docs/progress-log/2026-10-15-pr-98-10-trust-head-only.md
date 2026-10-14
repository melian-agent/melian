[Pull request #98](https://github.com/melian-agent/melian/pull/98): the maintainer's ruling on round eight's P1 (b1fdc83360b8c332), option (b). A committed range runs the mutation check only with `--trust-head`. This replaces the upstream rule in the previous entry.

- dd9db602 removes the inference from upstreams and reachability. A committed range is refused with "pass --trust-head if you have read this code and want its tests run", whether it has no upstream, tracks the repository, tracks a fork, was fetched from `pull/7/head`, or pulled a fork's commits. Each of the five, set up with real git, runs with the flag. A vouched range takes the check's settings from the base.
- 558aa894: the guard now hands the leave it granted to the `--trust-head` note, so the round-eight survivors in the note's condition, which were equivalent, are gone.
- 0a227e8a: `ProcessTable.kill` is proven to refuse 0, 1, -1 and -10 before it reaches a `process.kill` fake that records calls. A real child's pid reaches that fake unchanged. The mutation `pid <= 1` to `pid === 1` now fails a test.
- 9983dd1b8455d0cf's stale lines describe today's behaviour again. A checked-out range reads policy from the working tree, as before this pull request, except the mutation check's settings under `--trust-head`.

Mutations, each run by hand and each failing a test: the range trusted by default; the flag ignored; the base settings never taken, or taken without the flag; the note for every leave, for none, or dropped; `trust.writers` applied to every leave; the pid bound.

Case (a), the reviewer's uncommitted work, has no command behind it: Melian reviews commits only, so `WriterTrust`'s `checkout` stays in the type and the CLI never sets it.
