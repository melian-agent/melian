# Probes run under sandbox-runtime

Status: ruled by the maintainer, 2026-11-07, in [issue #285](https://github.com/melian-agent/melian/issues/285).

## Problem

On trust surfaces, Melian's rounds miss what a reviewer who runs probes finds. A lens reads and searches; it never runs anything.

Example: on [pull request #275](https://github.com/melian-agent/melian/pull/275), a head `biome.json` that extended `/proc/<pid>/environ` would have put the runner's logins in a public comment. The review of record found it by running Biome on such a file. `melian compare stats` counts nine `needs-execution` misses, and every one came from running something.

A probe is a short script a lens writes, with its fixture files, to show a claim. A model wrote it, and the model read the head, so the head's author can steer what the probe does. [The unconfined decision](2026-10-14-static-checks-run-unconfined.md) runs static checks unconfined and reserves a sandbox for agents. A probe is the agent's own code, so it is that case.

## Decision

Probes run under [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime), Apache-2.0, pinned at 0.0.81. It is the sandbox Claude Code uses: seatbelt on macOS and bubblewrap on Linux, with network traffic forced through a proxy it runs. Melian asks it for every rule and re-derives none.

`Probe`, in the pipeline, runs one script with its files. Its options name the head's worktree, the host's writer decision, a time limit and an output limit. It returns the exit code, the output up to the limit, whether the output was cut, and whether the run timed out. `close()` removes its scratch directory.

What the sandbox allows a probe:

- No network. The proxy's allow list is empty and nothing may ask to widen it. On Linux the probe has no network namespace at all; on macOS seatbelt lets it reach only the proxy, which refuses every host.
- A scratch `HOME` and `TMPDIR`, both under the probe's writable directory. The environment is an allow-list: `PATH`, `HOME`, `TMPDIR` and `LANG`, with the same reason static tools get no more.
- Writes to that directory alone. The script and its files sit beside it, readable but not writable, so a run cannot rewrite the probe a verifier will rerun. sandbox-runtime keeps `/tmp/claude` writable for its own use; Melian denies it.
- Reads of the head's worktree, of a dependency install the caller names, of Node's install, of sandbox-runtime's own helpers, and of the operating system's programs and libraries alone: `/bin`, `/sbin`, and `/usr`'s `bin`, `sbin`, `lib*`, `libexec` and `share`, with `/System` and `/private/var/select` on macOS and `/lib*` on Linux. Node does not start without its libraries and OpenSSL configuration, a probe that runs a shell needs the shell's, and Linux runs sandbox-runtime's seccomp helper from its package. The maintainer accepted these reads beyond the worktree and Node's install on 2026-11-07, keeping every deny below. Node's own `etc`, where a global npmrc can hold a registry token, is denied. Everything else is denied: the reviewer's home, `~/.ssh` and `~/.config` among it, every other checkout, `/etc` and `/tmp`. Inside the worktree, `.git`, `.env*`, `melian.secrets.yaml` and `melian.local.yaml` are denied too, as the standards loader never reads them.

Probes run for a writer's head only. A probe takes the host's `WriterTrust`, the decision `static.mutation` takes: a head a writer pushed to the base repository, or one the reviewer vouches for with `--trust-head`. A fork's head is refused, and so is a writer's under `trust.writers: false`. The sandbox narrows what a probe can reach; it does not make a stranger's head safe to execute on the reviewer's machine.

Fail closed. Before a probe runs, sandbox-runtime says whether it supports the platform and whether its dependencies are present: bubblewrap, socat and ripgrep on Linux, nothing more on macOS. Melian probes on macOS and Linux only; Windows, which sandbox-runtime supports in alpha, is refused. When any answer is no, or the sandbox fails to start, the probe is refused with that reason and never runs unconfined. `melian doctor` runs an empty probe and prints whether it ran.

A probe ends by recorded pid. While it runs, Melian records every process it sees descending from the command it started, each pid with its start time, as the mutation supervisor does. At the time limit, and again after it exits, Melian ends the recorded processes with SIGTERM and then SIGKILL. It never signals 0, 1, a negative pid or a process group.

sandbox-runtime's manager is one per process. Melian opens it with the first probe and resets it when the last one closes. Each probe passes its own paths to the wrap, so probes with different worktrees run side by side.

## What it gives up

- The probe shares the reviewer's kernel. An escape from sandbox-runtime, seatbelt or bubblewrap, or a kernel bug, is an escape: the probe then runs as the reviewer, with the reviewer's files and network. The package calls itself a research preview.
- macOS has no hold on a process once it leaves the tree. A probe whose child detaches between two scans of the process table is never recorded, so it outlives the probe. Seatbelt still confines it, and its writable directory is deleted at `close()`.
- Linux needs unprivileged user namespaces. Ubuntu 24.04, which GitHub's runners use, restricts them through AppArmor by default, so the CI job turns that off and installs the three tools. A host that keeps the restriction cannot probe.
- On Linux, bubblewrap shows a directory the probe may not read as an empty, writable tmpfs. A write there succeeds inside the sandbox and is lost when the probe ends; nothing reaches the host. A probe cannot tell a denied directory from an empty one.
- On macOS, sandbox-runtime 0.0.81 writes `com.apple.SecurityServer` and `com.apple.securityd.xpc` into its seatbelt profile unconditionally, and its configuration has no setting that denies a mach service: `allowMachLookup` only adds services. The maintainer ruled on 2026-11-07 that a test must show whether a probe reaches the keychain through them, and that probes do not land until it passes on a Mac. That test is not yet written.
- The operating system's programs and libraries are readable. They hold no user's data, but a probe can read which versions are installed.
- A probe can still burn CPU and memory up to its time limit. sandbox-runtime sets no resource limits.

## Deferred: microVMs

A microVM, such as microsandbox, libkrun or Firecracker, gives a probe its own kernel, so a kernel bug no longer reaches the host. It was considered and deferred. It needs a VM runtime and, on most hosts, nested virtualisation, which builders' cloud VMs and GitHub's runners may lack. A probe that cannot run anywhere a builder works finds nothing. The `Probe` class hides the sandbox behind `open`, `run` and `close`, so a microVM backend can replace sandbox-runtime without changing a caller, once the hosts Melian runs on offer one.
