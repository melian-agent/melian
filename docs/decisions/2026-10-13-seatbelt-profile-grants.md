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

What this gives up, and what stays open:

- A tool that needs a removed grant fails until someone adds the rule with the tool's name beside it. That is the point.
- `/etc/gitconfig` is not readable. A host that has one makes git inside the sandbox stop with "unable to access". A caller that runs git there sets `GIT_CONFIG_NOSYSTEM=1`.
- `sysctl-read` cannot be narrowed to names: libuv reads some by number. The host name is therefore readable.
- Seatbelt cannot close the bootstrap port. `launchctl print` lists the user's services from inside the sandbox. On this host launchd refused to create a job, set its environment, or run a command outside the sandbox; a request to restart a service the user already has was not tried, since it would disturb the host.
- bubblewrap's bind list was not reviewed this way. No Linux host was to hand.
