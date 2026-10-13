# Static tools run confined where the host offers a sandbox

Supersedes: none. [The sandbox decision](2026-10-08-head-code-runs-in-a-sandbox.md) stands: a check that executes head code runs in a sandbox or is skipped. This decision is about two checks that do not.

Problem: Biome and tsc run as the reviewer, on files a pull request wrote. They ran with the reviewer's real `HOME`, the whole disk readable, and an open network. Neither stock tool runs the head's code. But each reads the files the head names, and says what it found. No bug is needed for that to leak.

Example: a pull request from a fork commits `biome.json` with `"extends": ["/Users/reviewer/.pi/agent/auth.json"]`. Stock Biome 2.5.15 opens that file as a configuration, fails to make sense of it, and quotes it line by line in its error. The host stored that error in the check record and printed it in the terminal and the JSON. The review of record on [pull request #112](https://github.com/melian-agent/melian/pull/112) showed it with a fake key; main has done this since static tools landed. A parser bug would be worse, since a subverted tool could also send the file out, but the plain case needs none.

Whether these tools execute head code, checked in the code and the installed packages:

- The binary is the checkout's `node_modules/.bin/<tool>`, installed from the lockfile, or Melian's own. It is never the head's: a `node_modules` the head tracks is deleted from the worktree first.
- Biome 2.5.15 reads the head's `biome.json`, the configurations it `extends`, and GritQL plugins. A GritQL plugin is a pattern Biome matches; its binary holds no JavaScript engine to run one with.
- tsc 7.0.2 reads `tsconfig.json` and what it `extends`. The `plugins` field configures an editor's language service, and tsc never loads it.
- The worktree's workspace packages are the head's own sources. tsc type-checks them and does not import them.

That is a claim about the stock tools at those versions, not about whatever a checkout installs under their names. `binaryFor` runs the checkout's `node_modules/.bin/<tool>` when the checkout has one, and does not compare it with the package the lockfile declares. A checkout whose `typescript` has been patched by ts-patch has a `tsc` that loads the transformers a `tsconfig.json` names, and the head writes that file. Open risk, for the maintainer: when the checkout's installed tsc is patched in that way and the head's `tsconfig.json` names a transformer, static.tsc executes head code, confined where the host has a sandbox and unconfined where it has none. Nothing here detects it. Closing it means running only a binary that matches the declared package, or Melian's own.

So neither stock tool is a check that executes head code, and the sandbox decision's rule, skip where there is no sandbox, does not apply to them. [The pipeline guideline](../guidelines/pipeline.md#static-tools-run-in-the-execution-environment) said that running them "runs the revision's code"; that sentence was wrong and is corrected.

Choice: where the host offers a sandbox, Biome, tsc, and their `--version` probes run inside it.

- `runStaticTool` calls `Sandbox.detect` and then `runtimeFailure`, which starts Node inside the sandbox once. Both run their command through the run's `ExecutionEnv`, never in the Melian process.
- The profile is built in memory and passed inline, never read from a file in scratch.
- The tool reads the worktree, the installs the worktree links to, and its own install: the outermost `node_modules` above the tool's resolved path, which is Melian's when the checkout has no copy.
- It writes to scratch only, with `HOME` and `TMPDIR` there, and a `PATH` of Node's directory and the system's.
- A tool that lives in no install is granted as its one file, readable and startable, and nothing beside it.
- It gets no network: `SandboxPaths.loopback` is left absent.
- git, `ln`, and `rm` stay on the host. They are Melian's own commands on paths Melian chose, and git needs the repository's git directory, which the sandbox does not grant.

The fallback: where the host has no sandbox, or Node cannot start inside it, the tool runs unconfined exactly as before, and the review says so wherever it reports. Three kinds of host get it: Windows, Linux without bubblewrap or with user namespaces off, and a process already inside a seatbelt, such as a Codex task, where macOS refuses a nested one.

The fallback is visible. A note in a stored record was not enough: no renderer shows a passing check's notes, so a review on such a host read "Passed" and said nothing. Confinement is therefore a typed field on the check record, `{ confined: true }` or `{ confined: false, reason }`, carried from the run through the checks document, the verdict, and the published round.

- The terminal verdict lists "1 check ran outside a sandbox:" with each check and "ran unconfined: this host offers no sandbox".
- `melian review --json` carries the field on each record under `ran`, for confined and unconfined alike.
- The GitHub review body has a section, "Checks that ran outside a sandbox:", ahead of the checks that did not run.
- The ledger's run details name each such check.

A check is unconfined when either its head run or its base run was. A record with no field is a check with no tool to confine, or a record from before the field.

Enola's record says `unconfined`, with the reason "not yet confined", like any other tool that ran outside the sandbox. A record that said nothing would imply a confinement that did not happen. The cost is that every review whose tier runs Enola prints a warning, on every host, until Enola is confined. It is one line per review: a check has one record whatever its head and base runs did, and each renderer prints one line per record. The checks document moves to version 4, the verdict document to 7, and the published document to 8. An older build refuses the newer documents, which is right: it would otherwise republish a verdict and drop the warning. `test/fixtures/stored-v6` holds the three documents as the previous version wrote them, and a test reopens them.

A policy key that makes an unconfined run skip or fail is deferred to the per-rule resolution step. That step is where a repository will say, rule by rule and path by path, what blocks; a second, separate switch here would be a policy surface to review and migrate twice. Until then the default stays "run, with a visible warning", because these tools do not execute head code: refusing to lint on a host with no sandbox would cost every such review two checks to guard against a parser bug nobody has found.

Why the fallback may run at all: the stock tools execute no head code, but they read head-named files, so an unconfined run withholds their output. That is the whole argument; the first form of this decision said there was "no head code to stop" and only "a bug nobody has found" to fear, and both halves were wrong about what an unconfined tool can give away.

On a run that was not confined, nothing the tool printed reaches a record, a log, the terminal, or the JSON.

- A failure carries its reason code, the tool's exit code, and the fixed sentence "output withheld: the tool ran unconfined". That holds for the version probe, Biome's stderr, tsc's output, and Enola's logs alike.
- A diagnostic from the tool's structured report is kept only when its file really is inside the worktree, not a link out of it, and its message names no absolute path outside the worktree. A kept message is cut to 1,000 characters and written as visible text. The rest are dropped and counted in a note, never quoted.
- On a confined run messages stay as the tool wrote them, since the tool could read nothing to quote.

What that costs: on a host with no sandbox a broken tool says only that it broke, and the maintainer reruns it by hand to see why. A failed check carries its confinement too, so the crash on a host with no sandbox, the one case where the warning matters most, says "ran unconfined" in all four outputs.

A check that does execute head code gets no such fallback; the sandbox decision still skips it.

The loopback flag: `SandboxPaths.loopback` is off unless a caller sets it. A later caller that runs a tool which talks to its own workers over loopback, as Stryker's logging server does, sets it. Seatbelt cannot name a port the tool picks for itself, so the rule is every loopback port, and on macOS loopback is the host's own: the command can reach any service listening there. Such a caller needs a second control, writer trust, and must say why no narrower rule works. bubblewrap's private network namespace has no such hole. Biome and tsc open no socket, so they get none.

What this gives up:

- Each run spends two extra process starts on the probe, about 50 ms on this host.
- A tool that reads outside the worktree fails where it used to pass: a `tsconfig.json` that `extends` a path above the repository, or a globally installed type package. No repository reviewed so far does either.
- A confined run is torn down confined, three more process starts. A run that was not confined is torn down by host git as before. A crashed confined run is still removed on the host by the next run, of any build; [the grants decision](2026-10-13-seatbelt-profile-grants.md) says why that is left.

Enola is deferred. It has the strongest case, since it is the largest program reading head input, and the most unknowns:

- Its binary lives in Melian's state directory, outside every grant.
- It is a Go program whose strings include `git log` and GitHub addresses, so it may start git or expect a network.
- Nobody has run it inside the sandbox on either backend.

It stays outside until a host probe passes on macOS and Linux.

Proof: on macOS 26.5, `runStaticTool` ran the real Biome and tsc on this repository's own head inside seatbelt. Both reported no findings and no notes. A test gives a fake tool a credential file to read, a path beside scratch to write, and a local port to connect to; all three fail inside the sandbox and succeed outside it. Two tests cover the fallbacks and assert that the real Biome still reported its finding.
