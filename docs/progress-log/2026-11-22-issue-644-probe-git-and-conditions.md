# Issue 644: probes run git and import workspace packages

Builder agent, for [issue #644](https://github.com/melian-agent/melian/issues/644).

A probe can now import a workspace package by name and, on macOS, run git. `probe.conditions` in the root `melian.yaml` names the Node conditions the probe's process resolves under, and Melian's own names `@melian-agent/source`. The probe's folder links the tree's `node_modules`. On macOS, `probeGit` in `packages/pipeline/src/probe-git.ts` asks the host where the developer tools' git lives before the sandbox starts, and grants only what its checks allow. `melian doctor`'s `probes` line now warns when git cannot run in a probe.

The tests came first. `packages/pipeline/test/probe-git.test.ts` is the attacking review of the widened read, briefed as unit tests against a fake host, and was written before `probeGit`. The bare-import tests in `probe.test.ts` and `probe-git-sandbox.test.ts` failed with `ERR_MODULE_NOT_FOUND` without the install link, and pass with it. On Linux the git and CLI tests in `probe-git-sandbox.test.ts` passed before the change too, since only macOS lacked git; CI's macOS job runs them.

[The decision](../decisions/2026-11-22-probes-run-git-and-workspace-imports.md) records the checks and what the host run must still show.
