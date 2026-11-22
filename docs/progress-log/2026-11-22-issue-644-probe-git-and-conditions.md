# Issue 644: probes run git and import workspace packages

Builder agent, for [issue #644](https://github.com/melian-agent/melian/issues/644).

A probe can now import a workspace package by name and, on macOS, run git. `probe.conditions` in the root `melian.yaml` names the Node conditions the probe's process resolves under, and Melian's own names `@melian-agent/source`. The probe's folder links the tree's `node_modules`. On macOS, `probeGit` in `packages/pipeline/src/probe-git.ts` asks the host where the developer tools' git lives before the sandbox starts, and grants only what its checks allow. `melian doctor`'s `probes` line now warns when git cannot run in a probe.

The tests came first. `packages/pipeline/test/probe-git.test.ts` is the attacking review of the widened read, briefed as unit tests against a fake host, and was written before `probeGit`. The bare-import tests in `probe.test.ts` and `probe-git-sandbox.test.ts` failed with `ERR_MODULE_NOT_FOUND` without the install link, and pass with it. On Linux the git and CLI tests in `probe-git-sandbox.test.ts` passed before the change too, since only macOS lacked git; CI's macOS job runs them.

[The decision](../decisions/2026-11-22-probes-run-git-and-workspace-imports.md) records the checks and what the host run must still show.

## The host run

The coordinator ran the real-sandbox tests on macOS at 63c2e00b2. The bare import passed. git init failed, as did the CLI review it starts, with `fatal: unable to access '/etc/gitconfig': Operation not permitted`: the file does not exist there, and the sandbox refused its open though the probe granted the path. A fix commit gives the probe's git `GIT_CONFIG_NOSYSTEM=1` when the system configuration is absent, and grants no read of it. Melian's git keeps that variable from the caller, through core's `withoutGitVariables`. `melian doctor`'s probes line now carries git's own words, without Node's stack. Each fix started with a failing test: five failed at 63c2e00b2 and pass after.

The coordinator's rerun at ac081e3e7 passed all three real-sandbox tests on macOS, Apple Git 2.50.1, with no system configuration on that host, and `melian doctor` read `ok probes run under sandbox-runtime, git included`. The coordinator then asked for a narrower read: the developer tools' `usr/bin` holds clang, make and python3 as well as git. A later commit grants git's exec path instead, puts its own `git` on the probe's `PATH`, and adds a macOS test that a probe cannot run clang, cc, make or python3.
