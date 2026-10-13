# Every seatbelt grant names the program that needs it

Supersedes: none.

Problem: the seatbelt profile grew by trial. Four review rounds in a row each found one grant wider than its use: `/dev/tty`, all of `/dev`, the directory above Node, then `xcrun`'s cache. Nobody could say which program needed `ipc-posix-shm*` or `/Library/Preferences`, so nobody could say it was safe to keep.

Example: `(allow process-exec)` with no path let a sandboxed command start any program on the disk. `/Library/Preferences` held the host's network configuration, readable to every command.

Choice: a grant stays only when a named program fails without it. Each rule was removed in turn and nine commands run inside the sandbox: Node, `/bin/sh`, `date`, git, the git shim, the housekeeping script, Biome and tsc on this repository, and one Vitest file. The profile now holds these rules and no others.

| Rule | Who needs it |
| --- | --- |
| `process-fork` | Bash forks for every command, Node for every child. |
| `process-exec` on the readable paths | A program starts only from a place the command may read. Before, any path. |
| `file-map-executable` on the readable paths | dyld maps the libraries a program links. Before, any path. |
| `signal` to the same sandbox | A parent stops its own children, as Node does at a timeout. |
| `sysctl-read` | Node aborts at start without it. It reads host description only: hardware, kernel version, host name. |
| read `/` as a literal | dyld lists the root; without it a process aborts with status 134 and no message. |
| read `/usr/lib`, `/System` | dyld, system libraries, and frameworks. |
| read `/usr/bin`, `/bin` | `sh`, `bash`, `env`, `date`, and the other tools a command line names. |
| read `/usr/share` | Locale and ICU data the system libraries load. |
| read `/private/var/db/timezone`, and `/private/etc/localtime` as a literal | `date` and Node, so a log's times match the reviewer's. |
| read `/private/var/select/sh` and `developer_dir` as literals | `/bin/sh` chooses its shell by the first; `xcrun`, behind the git shim, reads the second. |
| read the developer tools directory | The real git. |
| read the Node executable as a literal, and `lib/node_modules` and `include/node` under an owned prefix | Node; npm, npx, and corepack; node-gyp. [The runtime-grant decision](2026-10-12-sandbox-node-runtime-grants.md) sets the rule. |
| read the caller's installs | The tool the caller runs and its dependencies. |
| read, start, and map a standalone tool, as a literal | A tool that lives in no install, such as a `.bin` entry linked to a program elsewhere. It gets its own file and nothing beside it. |
| read and write scratch | The run's own files. |
| metadata of `/`, `/etc`, `/var`, and each directory above a granted path | Path lookup stats each directory on the way. Metadata shows a directory exists, never its contents. |
| read `/dev/null` and `/dev/urandom`; write `/dev/null` | Shell redirects; programs that seed from the device, such as Python. |
| deny `/dev/tty` | Stated, so a later device grant cannot open the terminal by accident. |
| loopback, and read `/private/etc/hosts`, only when the caller asks | A tool that talks to its own workers; the resolver needs the file to find `localhost`. |

Removed, because no command needed them:

- `process-info*`, `ipc-posix-sem`, `ipc-posix-shm*`, `system-mac-syscall`, and the Mach lookup.
- `/Library/Preferences`, `/Library/Apple`, and `/private/var/db/dyld`.
- The rest of `/private/etc` and `/private/var/select`.
- The devices `/dev/zero`, `/dev/random`, and `/dev/dtracehelper`.

dyld opens `/dev/dtracehelper` to register trace probes and carries on without it. This replaces the device list in [the devices decision](2026-10-12-sandbox-devices-are-literals.md), which is corrected to match.

One test pins the whole profile, rule for rule, so a grant added anywhere fails it. A second runs inside the real sandbox and checks that a program outside the readable paths does not start, that `ps` and a signal to a process outside fail, and that each removed path and device is refused.

A standalone tool gets its file and nothing beside it. Before this grant such a tool could not start inside the sandbox and the check read `toolMissing`, where the build before ran it. The tool may start and then fail because it needs a library or a script beside itself. That is a recorded `toolFailed` carrying the tool's own message, never `toolMissing`. The tool is there, and what it lacks is a grant somebody has to argue for. bubblewrap binds the same single file.

What this gives up, and what stays open:

- A tool that needs a removed grant fails until someone adds the rule with the tool's name beside it. That is the point.
- `/etc/gitconfig` is not readable. A host that has one makes git inside the sandbox stop with "unable to access". A caller that runs git there sets `GIT_CONFIG_NOSYSTEM=1`.
- `sysctl-read` cannot be narrowed to names: libuv reads some by number. The host name is therefore readable.
- Seatbelt cannot close the bootstrap port. `launchctl print` lists the user's services from inside the sandbox. On this host launchd refused to create a job, set its environment, or run a command outside the sandbox; a request to restart a service the user already has was not tried, since it would disturb the host.
- Seatbelt gives no lifecycle control. `process-fork` cannot be withheld, and nothing ends a command's descendants when the command exits. A subverted Biome or tsc could start a child, detach it, and exit; the child runs on. It stays inside the same profile for as long as it lives: it reads only what the profile reads, writes only under the scratch path, signals only its own kind, and has no network. bubblewrap has no such gap, since `--die-with-parent` and its process namespace end everything with the command. Melian never signals a process group, pid 0, or a negative pid, so it does not hunt the child down; a wrapper that did would be the wrong trade for tools that do not execute head code. Instead nothing the child can still reach matters:
  - The host reads each output file once, through the no-follow reader, and judges what it read. It never opens the file again.
  - A confined run is torn down confined. The trees and scratch are removed from inside the sandbox, where a path the child swaps for a link leads nowhere, and host git is never asked to remove a tree. A teardown that cannot finish fails the check, because scratch that will not empty is scratch something still writes to.
  - After teardown the child holds a write grant on a path that no longer exists. It can recreate that directory in the temporary directory and nothing else.
  - What remains is its use of CPU and memory until the host kills it or it ends.

  A test leaves a detached child behind, lets it rewrite the output after the host's read, and checks the result is the first read's, the write beside scratch never lands, and scratch is gone while the child still runs. For a check that executes head code the control is a supervisor that records each descendant's pid and start time and ends each by its own pid, which [pull request #98](https://github.com/melian-agent/melian/pull/98) brings.
- A crash between a confined command and its teardown leaves scratch under `melian-static-`, which the next run of any build removes on the host. Scratch that must never be removed that way takes the `melian-confined-` prefix; a Biome or tsc run does not, since an old build must still see its live lock.
- bubblewrap's bind list was read against this table, below, and CI is its only test host. No command was run with each bind removed in turn, as was done for seatbelt.

## The bubblewrap command, bind by bind

bubblewrap starts from an empty root, so its list is what exists at all, not what is allowed. CI on Ubuntu 24.04 is the host these were checked on.

| Flag or bind | Who needs it |
| --- | --- |
| `--unshare-all` | A network namespace with its own loopback and nothing on it; a process namespace that hides the host's processes; no shared IPC. |
| `--die-with-parent` | Everything in the namespace ends with the command, so nothing outlives a run. |
| `--new-session` | The command has no controlling terminal, so `/dev/tty` opens nothing. |
| `/usr/bin`, `/bin` | `bash`, `sh`, `env`, `date`, git. |
| `/usr/lib`, `/usr/lib64`, `/lib`, `/lib64` | The dynamic loader and the libraries every program links. |
| `/usr/share` | Locale data, and the zone files `/etc/localtime` points into. |
| `/etc/ld.so.cache` | The loader's index of those libraries. |
| `/etc/alternatives` | A merged-`/usr` host links `/usr/bin` entries through it. |
| `/etc/nsswitch.conf`, `/etc/passwd`, `/etc/group` | Name lookups: git cannot name the user it commits as without them. |
| `/etc/localtime` | `date` and Node, so a log's times match the reviewer's. |
| `/etc/hosts`, only when the caller asks for loopback | The resolver, to find `localhost`. It can name machines on the reviewer's network, so it is not bound otherwise. |
| `--proc /proc` | A process table of the namespace alone. Node reads `/proc/self`, and the housekeeping script opens files through `/proc/self/fd`. |
| `--dev /dev` | The few devices bubblewrap makes itself: `null`, `zero`, `full`, `random`, `urandom`, `tty`, and a private `pts` and `shm`. |
| `--tmpfs /tmp` | An empty `/tmp` for scratch to mount under; the host's is not visible. |
| the Node executable, and its owned `lib/node_modules` and `include/node` | As under seatbelt. |
| a standalone tool, as its one file | As under seatbelt. |
| the caller's installs, read-only | The tool and its dependencies. |
| scratch, read and write | The run's own files. |

Removed in this review: `/usr/sbin` and `/sbin`, which seatbelt already refused and no command needs, with both dropped from `PATH`; `/lib32`, for which no 64-bit tool has a use; and `/etc/hosts` unless loopback is asked for. `/usr/local` was never bound.

A test builds the command and pins the system binds in order. In CI a script inside the namespace lists `/etc` and `/usr`, counts the processes it can see, and tries the terminal. Beside it a system tool runs and the script reads itself, so an empty listing is the namespace's doing and not a failed start. The same CI run puts Biome, tsc, the housekeeping script, the output-link refusal, and the confined teardown through bubblewrap.
