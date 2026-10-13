# Static tools run confined where the host offers a sandbox

Supersedes: none. [The sandbox decision](2026-10-08-head-code-runs-in-a-sandbox.md) stands: a check that executes head code runs in a sandbox or is skipped. This decision is about two checks that do not.

Problem: Biome and tsc run as the reviewer, on files a pull request wrote. They ran with the reviewer's real `HOME`, the whole disk readable, and an open network. Neither runs the head's code, so nothing known was wrong. But each parses input the head controls: source files, `biome.json`, `tsconfig.json`, a GritQL plugin. A parser bug in either would run with everything the reviewer can reach.

Example: a pull request from a fork adds a source file built to exploit a bug in a tool's parser. The subverted tool reads `~/.pi/agent/auth.json` and posts it to a server. The review reports a tool crash.

Whether these tools execute head code, checked in the code and the installed packages:

- The binary is the checkout's `node_modules/.bin/<tool>`, installed from the lockfile, or Melian's own. It is never the head's: a `node_modules` the head tracks is deleted from the worktree first.
- Biome 2.5.15 reads the head's `biome.json`, the configurations it `extends`, and GritQL plugins. A GritQL plugin is a pattern Biome matches; its binary holds no JavaScript engine to run one with.
- tsc 7.0.2 reads `tsconfig.json` and what it `extends`. The `plugins` field configures an editor's language service, and tsc never loads it.
- The worktree's workspace packages are the head's own sources. tsc type-checks them and does not import them.

So neither tool is a check that executes head code, and the sandbox decision's rule, skip where there is no sandbox, does not apply to them. [The pipeline guideline](../guidelines/pipeline.md#static-tools-run-in-the-execution-environment) said that running them "runs the revision's code"; that sentence was wrong and is corrected.

Choice: where the host offers a sandbox, Biome, tsc, and their `--version` probes run inside it.

- `runStaticTool` calls `Sandbox.detect` and then `runtimeFailure`, which starts Node inside the sandbox once. Both run their command through the run's `ExecutionEnv`, never in the Melian process.
- The profile is built in memory and passed inline, never read from a file in scratch.
- The tool reads the worktree, the installs the worktree links to, and its own install: the outermost `node_modules` above the tool's resolved path, which is Melian's when the checkout has no copy.
- It writes to scratch only, with `HOME` and `TMPDIR` there, and a `PATH` of Node's directory and the system's.
- It gets no network: `SandboxPaths.loopback` is left absent.
- git, `ln`, and `rm` stay on the host. They are Melian's own commands on paths Melian chose, and git needs the repository's git directory, which the sandbox does not grant.

The fallback: where the host has no sandbox, or Node cannot start inside it, the tool runs unconfined exactly as before, and the check's record carries a note: "biome ran unconfined: this host offers no sandbox." Three kinds of host get it: Windows, Linux without bubblewrap or with user namespaces off, and a process already inside a seatbelt, such as a Codex task, where macOS refuses a nested one.

Why the fallback is not fail-open: fail-open means a control that guards a known danger gives way and the danger proceeds unseen. Here there is no head code to stop, so skipping would remove two checks from every such host to guard against a bug nobody has found. The sandbox is defence in depth for these tools. Its absence leaves the run where every run was before this change, and the note says so in the record. A check that does execute head code gets no such fallback; the sandbox decision still skips it.

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
