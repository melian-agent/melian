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

The guard. A check that runs the head's own code runs only when the host says it may, and the host decides from what it knows itself, never from anything the head supplies. It may in three cases.

1. The head is the reviewer's own checked-out commit. Running its tests is what `npm test` does.
2. The pull request's head sits in the base repository and was pushed by someone with write, maintain or admin permission there. The pusher of the exact head decides, and the author only when GitHub names no pusher. A fork, a pusher without write access, an identity or permission that cannot be read, and `trust.writers: false` in the base's policy each refuse. This is [the head-writer rule](2026-10-12-trusted-writer-requires-base-repository-head.md), unchanged.
3. The host has declared itself an isolated runner: a machine that holds nothing a stranger's code may not reach, as a hosted CI runner is. Then any head runs, a fork's too.

Otherwise the check does not run, and its record says why: "the head is from a fork and this host is not an isolated runner", or the permission that could not be read.

Where the declaration lives. `melian review --isolated-runner`, or `MELIAN_ISOLATED_RUNNER=1` in the environment, which is the form a workflow sets. Both belong to the host. A key in `melian.yaml` was rejected: the file is the repository's, a pull request can change it, and reading it from the base only moves the question to who may change the base. Whether a machine is isolated is a fact about the machine, so the machine says it. The declaration stands ahead of the other two cases, so it holds where a repository trusts no writer. The typed decision travels with the review as `WriterTrust`, `{ trusted: true, by: "checkout" | "writer" | "isolatedRunner" }` or `{ trusted: false, detail }`, is part of the run's identity, and partitions the incremental cache: a head that ran only because the host is isolated keeps results of its own.

Not approved without it. When a static check is in the tier and did not run, the review is `not reviewed`: never `passed`, never `findings`. That holds for the guard's refusal, for a run past its timeout, for a checkout without Stryker, and for a failed or skipped Biome, tsc or Enola run. The one skip of `static.mutation` that lets a review go on is a change with no production TypeScript lines: the check looked, and there was nothing for it to judge. The verdict line, the `melian/review` status and the review's "Checks that did not run" list each name the check and the reason, and the status is `error`. So a contributor who reviews a fork's pull request on a laptop sees "Not reviewed: static.mutation skipped (the head is from a fork and this host is not an isolated runner; ...)", and the repository's build, where the host declares isolation, runs it. A repository can still name a check in `checks.allowSkip`; that is its maintainer's choice, read from the base.

What this gives up.

- A stranger's fork reviewed on a laptop gets no mutation check, by design, and that review cannot be the review of record.
- On an isolated runner the evidence is the fork's own. Its tests write the report Stryker reads, and a test can throw only while a mutant is active, so every mutant reads as killed. The `forged-mutation-kill` guardrail catches the plain spelling and is a warning, not a control; a name built at run time passes it. Isolation protects the machine, not the result. A clean mutation check on a fork's head says its tests ran, no more, as a fork's own green CI does. Whether such a run should count toward approval is on the readiness list.
- A static tool reads whatever the head names, on the reviewer's machine: a head's `biome.json` that extends an absolute path has Biome quote that file. The machine is the reviewer's own, reviewing the reviewer's own repository, or a runner's. Reviewing an untrusted pull request on a machine that holds secrets is the reviewer's risk to weigh, as running its `npm install` is.
- A writer's tests run as the reviewer, with the reviewer's network and files. So does every test the reviewer runs by hand.
- The declaration is a host's word. A shared, long-lived review server that declares itself isolated is trusted to be so; whether such a server counts, and who may declare it, is an open question on the readiness list.

Four things are kept from the sandbox work, because none of them is confinement. The supervisor ends a run's processes by recorded pid, which is hygiene. The worktree lock keeps the one form every build reads, with main's cleanup copied verbatim as its test. A run that loses its scratch says so. Nothing signals pid 0, pid 1, a negative pid or a process group.
