# Static checks run unconfined; only agents are sandboxed

Supersedes: [Head code runs in a sandbox](2026-10-08-head-code-runs-in-a-sandbox.md). That decision is retired whole; the clause of it that survives, that writer trust decides whose code may run, is restated in the guard below.

Problem: the mutation check runs a pull request's own tests, and the first design put every check that runs head code inside a sandbox Melian builds itself, seatbelt on macOS and bubblewrap on Linux, inside the reviewer's own process. Melian reviews a repository's own code, on the maintainer's machine or on the repository's runners. A sandbox built there has to hold against code the maintainer already runs with `npm test`, and it has to do so on every host, including the ones that offer no sandbox at all.

Example: three attacking reviews of [pull request #112](https://github.com/melian-agent/melian/pull/112), which carried that sandbox, found its limits rather than holes in its rules.

- No lifecycle control on macOS. Seatbelt has no hold on a process once its command exits, so a test could leave a process writing in scratch after the check returned, and every teardown had to assume one.
- The launchd channel. A profile cannot close the bootstrap port; `launchctl print` worked from inside, and each denial had to be found and named one program at a time.
- A fallback wherever no sandbox exists. Codex's seatbelt forbids a nested one, Windows has none, and a Linux host may forbid user namespaces. Each fallback then leaked in its own way: a stock Biome echoing a file a head's `extends` named, tsc's line numbers spelling out a file whose messages were withheld, withheld messages making an introduced Enola violation read as pre-existing. Each fix opened the next finding.

Twelve rounds on [pull request #98](https://github.com/melian-agent/melian/pull/98) and five on #112 produced no clean one.

Choice, in the maintainer's words: "This is your code base running either on your machine or your runners, I don't think we even need to sandbox any tools except agents." "Static analysis tools don't need to run in a sandbox, only agents do." On forks: "We assume fork code is untrusted, but it only runs within runners it would run on today anyway -- they are themselves isolated. Isolation model is same as current github forks."

So no static check is sandboxed. Biome, tsc and Enola run as they do on `main`. `static.mutation` runs Stryker as an ordinary child process with the environment every static tool gets: `PATH`, `HOME`, `TMPDIR` and `LANG`, and no other variable the Melian process holds. The sandbox work is kept at the tag `archive/sandbox-boundary-r5`, for the agents that will need one; nothing of it lands.

The guard. A check that runs the head's own code runs only when the host says it may, and the host decides from what it knows itself, never from anything the head supplies. It may in two cases.

1. The head is the reviewer's own checked-out commit. Running its tests is what `npm test` does.
2. The pull request's head sits in the base repository and was pushed by someone with write, maintain or admin permission there. The pusher of the exact head decides, and the author only when GitHub names no pusher. A fork, a pusher without write access, an identity or permission that cannot be read, and `trust.writers: false` in the base's policy each refuse. This is [the head-writer rule](2026-10-12-trusted-writer-requires-base-repository-head.md), unchanged.

Otherwise the check does not run, and its record says why, then "a head from outside the repository's writers runs its tests only in a credential-free job, which arrives with the Actions host". The typed decision travels with the review as `WriterTrust`, `{ trusted: true, by: "checkout" | "writer" }` or `{ trusted: false, detail }`, and is part of the run's identity.

Both leaves are facts about the head commit, not about the host: the commit was the reviewer's own, or a writer pushed it to the base repository. A task a crash left pending keeps its leave in its stored input, and resuming it later runs the same commit the leave was given for. So no run-time recheck is needed. A later review of the same revision whose decision differs takes over the revision and ends the earlier task, as before.

A fork's head: two jobs, at milestone 3. The maintainer's ruling: a fork's mutation check runs in "a separate job, no secrets". That is GitHub's usual split for a pull request from a fork.

1. A job with no credentials and no publishing runs the fork's tests and the mutation check, and hands its result on as an artefact.
2. A second job, which holds the GitHub token and the model keys, runs the lenses, reads that result, and publishes. It never executes head code.

That design belongs to milestone 3's Actions host. Until it exists, a head that is neither the reviewer's own checkout nor a writer's runs no mutation check anywhere, and the review reads `not reviewed`. An earlier draft of this pull request let a host declare itself an isolated runner, with a flag or an environment variable, and run any head beside its own credentials. Its tests could then read the review's environment and token and write into the checkout's install and Melian's storage before the verdict was done. Each round of review found another path by which a stored declaration outlived the host that made it. The declaration is gone; the two-job design replaces it.

A fork's result counts, "like CI tests". When the credential-free job runs, its clean result is accepted as a fork's own CI test results are accepted. That result is forgeable by the head: its tests write the report Stryker reads, and a test can throw only while a mutant is active, so every mutant reads as killed. The `forged-mutation-kill` guardrail catches the plain spelling and is a warning, not a control; a name built at run time passes it. Human review before merge is the control, as it is for a fork's green CI. Survivors the fork's run reports still count as findings.

Not approved without it. When a static check is in the tier and did not run, the review is `not reviewed`: never `passed`, never `findings`. That holds for the guard's refusal, for a run past its timeout, for a checkout without Stryker, and for a failed or skipped Biome, tsc or Enola run. The one skip of `static.mutation` that lets a review go on is a change with no production TypeScript lines: the check looked, and there was nothing for it to judge. The verdict line, the `melian/review` status and the review's "Checks that did not run" list each name the check and the reason, and the status is `error`. So a contributor who reviews a fork's pull request sees "Not reviewed: static.mutation skipped (the head is from a fork; ...)". A repository can still name a check in `checks.allowSkip`; that is its maintainer's choice, read from the base.

The timeout is provisional. The default `static.mutation.timeout` is 7,200 seconds, and the schema allows no more; every other static tool keeps its 3,600-second ceiling. The maintainer's ruling: "longer timeout everywhere, we'll make the call later on whether the return is worth it. I want to see how it works in practice with smaller PRs". This pull request's own run passed an hour: 1,049 mutants over 22 files, a related run of 112 test files that hit Stryker's own 20-minute dry-run limit, and a whole-suite run of 18 minutes 48 seconds for 4,041 tests. The line budget and concurrency stay as they were. The two hours will be revisited with measurements on smaller pull requests. Stryker's `dryRunTimeoutMinutes` could end the run first, so the runner sets it to Melian's timeout in whole minutes, rounded up: Melian's timeout is the only limit that ends the run.

What this gives up.

- A fork's pull request gets no mutation check until the Actions host's credential-free job exists, and reads `not reviewed` meanwhile. A writer can push the fork's head to the base repository to have it checked.
- A static tool reads whatever the head names, on the reviewer's machine: a head's `biome.json` that extends an absolute path has Biome quote that file. The machine is the reviewer's own, reviewing the reviewer's own repository, or a runner's. Reviewing an untrusted pull request on a machine that holds secrets is the reviewer's risk to weigh, as running its `npm install` is.
- A writer's tests run as the reviewer, with the reviewer's network and files. So does every test the reviewer runs by hand.
- A check can now take two hours, and a review waits on it.

Four things are kept from the sandbox work, because none of them is confinement. The supervisor ends a run's processes by recorded pid, which is hygiene. The worktree lock keeps the one form every build reads, with main's cleanup copied verbatim as its test. A run that loses its scratch says so. Nothing signals pid 0, pid 1, a negative pid or a process group.
