# The mutation run alone asks for loopback

Supersedes: none. It applies [the confined static tools decision](2026-10-13-static-tools-run-confined.md), which left the loopback flag off for every caller and set what a caller that turns it on must say.

Problem: `SandboxPaths.loopback` is absent by default, and a command then has no network rule at all on macOS. Stryker cannot run that way. Its main process starts a logging server with `listen()` on a port the system picks, and each worker connects to it; without the rule the first real run failed with `listen EPERM`.

Example: `static.mutation` on Melian's own branch, on macOS, with no network rule. Stryker exits before its dry run, the check fails closed, and no review of a pull request with production TypeScript can finish.

Choice: `MutationRun` sets `loopback: true` on the paths of one command, the one that runs Stryker, and on the trial start of Node under those same paths. Nothing else in the run gets it. The housekeeping commands that read, write and remove scratch, and Biome and tsc, run with no network rule.

Why no narrower rule works. Stryker 10.0.0 has no option, variable or plugin that fixes the port: `node_modules/@stryker-mutator/core/dist/src/logging/logging-server.js` calls `listen()` with none, and the workers learn the address in a message. Seatbelt cannot name a port the command picks, so the rule is `localhost:*`.

What this gives up. On macOS loopback is the host's own, so the head's tests can reach any service the reviewer runs on localhost: a development database, a local model server, a debugger port. The second control is writer trust: the check runs only for a head in the base repository whose pusher has write permission, as [the head-writer decision](2026-10-12-trusted-writer-requires-base-repository-head.md) records. bubblewrap's private network namespace has a loopback with nothing on it, so Linux has no such hole.

Before narrowing the rule, read that file in the Stryker version being upgraded to for a port option.

`test/static.test.ts` checks that one command of a mutation run carries the flag, the one that starts the runner, and that the trial start does. Removing the flag fails that test, and on a macOS host the real-sandbox run in `test/mutation-real.test.ts`.
