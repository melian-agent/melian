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
- macOS has no hold on a process once it leaves the tree. A probe whose child detaches between two scans of the process table is never recorded, so it outlives the probe. Seatbelt still confines it, and its writable directory is deleted at `close()`. A detached child that still holds the probe's standard output would keep the run from ever seeing the streams close; the time limit therefore stops the recorded tree, waits a short grace for the streams, and then abandons them and returns, rather than waiting on an escaped grandchild.
- The time limit is Melian's, and it only holds while Melian runs. A watchdog inside the runner exits the probe's own process at its limit even if Melian is killed, as a backstop; a grandchild that has already reparented away from the runner escapes both, confined by the sandbox until it ends on its own.
- Cleanup never changes a mode or lists a directory by path after looking at it: it relaxes only the scratch's own fixed directories through an `O_NOFOLLOW` descriptor, so a survivor that swaps one for a symlink to a host directory cannot steer a `chmod` onto the target. A directory the probe locked deeper inside its scratch, or a file it made immutable with `chflags`, can therefore block removal; `close()` then leaves the scratch in place and returns the path rather than risk a host change or let the failure replace the probe's result, and `melian probe` prints that leftover and exits non-zero. A leftover scratch is accepted; a host change is not.
- A worktree whose name holds a glob character, such as `[ab]`, `*`, `?` or `{c,d}`, still has its `.git` and `.env*` denied: the deny patterns only ever deny, so a broad match is safe, and a test holds the denials for those names. Every path the probe may read is passed literally, so such a name never reads as a glob.
- Linux needs unprivileged user namespaces. Ubuntu 24.04, which GitHub's runners use, restricts them through AppArmor by default, so the CI job turns that off and installs the three tools. A host that keeps the restriction cannot probe.
- On Linux, bubblewrap shows a directory the probe may not read as an empty, writable tmpfs. A write there succeeds inside the sandbox and is lost when the probe ends; nothing reaches the host. A probe cannot tell a denied directory from an empty one.
- On macOS, sandbox-runtime 0.0.81 writes `com.apple.SecurityServer` and `com.apple.securityd.xpc` into its seatbelt profile unconditionally, and its configuration has no setting that denies a mach service: `allowMachLookup` only adds services. The maintainer tested on 2026-11-07 whether a probe reaches the keychain through them. He ran `melian probe` from this branch at bad33202 on his Mac, against two canaries in his login keychain, a generic and an internet password added with `-A`, which `security` read outside the sandbox. Inside the probe, `find-generic-password` and `find-internet-password` each failed, through the default search list and with the login keychain named by its path, answering "SecKeychainSearchCopyNext: The specified item could not be found". `dump-keychain` on that path returned no canary. `list-keychains` answered. The keychain is unreachable from a probe, so macOS probes stay on. `packages/pipeline/test/probe-keychain.test.ts` repeats the test on CI's macOS runner, against a throwaway keychain of its own.
- The operating system's programs and libraries are readable. They hold no user's data, but a probe can read which versions are installed.
- A probe can still burn CPU and memory up to its time limit. sandbox-runtime sets no resource limits.

## Deferred: microVMs

A microVM, such as microsandbox, libkrun or Firecracker, gives a probe its own kernel, so a kernel bug no longer reaches the host. It was considered and deferred. It needs a VM runtime and, on most hosts, nested virtualisation, which builders' cloud VMs and GitHub's runners may lack. A probe that cannot run anywhere a builder works finds nothing. The `Probe` class hides the sandbox behind `open`, `run` and `close`, so a microVM backend can replace sandbox-runtime without changing a caller, once the hosts Melian runs on offer one.
