# tsc's projects come from tsc's effective configuration

Status: built for [issue #312](https://github.com/melian-agent/melian/issues/312). The maintainer ruled on the issue that Melian follows tsc where `extends` and `references` meet ([first ruling](https://github.com/melian-agent/melian/issues/312#issuecomment-6715610678)), and that tsc decides what an empty project means ([second ruling](https://github.com/melian-agent/melian/issues/312#issuecomment-6716018703)).

Amends: [Melian stores no Biome or tsc text](2026-11-06-static-configuration-stays-in-the-checkout.md), its amendment of Ask the authority for tsc project resolution, and the third point of its decision, on how Melian reads tsc's project files.

## Problem

Melian decided which projects tsc checks by reading each `tsconfig.json`'s own `files`, `include` and `references`. A project that takes them from the base it extends read as something else.

Example: `{ "extends": "./base.json", "files": [] }`, where the base sets `include: ["src/**/*.ts"]`. Melian read an empty project and raised `nothingToCheck`, so the review read not reviewed, though `tsc -p` checks the inherited files. Round finding `46f82987584733f5` on [pull request #282](https://github.com/melian-agent/melian/pull/282) raised it.

It failed open too. `{ "extends": "./base.json" }`, whose base holds `files: []` and `references`, has no literal `files` or `include`, so Melian ran `tsc -p` on it as it stood. tsc inherits no `references` through `extends`, so that run checked nothing and read as clean. So did a reference to a project file that does not exist.

## Decision

Melian asks tsc. For each project it runs `tsc --showConfig -p <project>` in the worktree, under the same timeout and output bound as tsc's own run, and reads the effective `files` and `references` from its JSON:

- A project whose effective `files` are not empty is checked as it stands.
- A project with no effective files is replaced by each project its own `references` name, resolved as before.
- A project with neither is still run with `tsc -p`, and Melian keeps what tsc reports. tsc calls most such projects an error: TS18002 for an empty `files`, TS18003 for an `include` that matches nothing, TS5083 for a base it cannot read. Each becomes a finding on the project's first line, as any diagnostic without a file does. A run that reports nothing and exits 0 checked nothing, and when no project checked anything the check fails with `nothingToCheck`. That covers a root whose only references come from its base.
- `--showConfig` exiting non-zero, or printing anything but a JSON object, fails the check with `toolFailed`, an exit code and a fixed sentence naming the command. Melian keeps none of its output, as it keeps none of tsc's.
- A project file whose real path leaves the worktree is refused unread, as before. So is a project any of whose effective files lies above the worktree or has a real path outside it, through an `extends` or a committed link. The refusal names the project, never the file: an outside file's name is outside text.

## Why

Ask the authority. tsc decides what `extends` contributes, how `${configDir}` expands and which globs match. Hand-reading the chain is the route [the earlier decision](2026-11-06-static-configuration-stays-in-the-checkout.md) found does not converge. `--showConfig` answers in the worktree, from the same binary that then checks the project.

## What this gives up

- Each project costs one more tsc process.
- A committed link to an outside file, under a project's `include`, no longer gets a tsc run: the project is refused, where [the earlier decision](2026-11-06-static-configuration-stays-in-the-checkout.md) ran tsc and kept only counts and places. A `/// <reference>` or an import that reaches an outside file is no effective file, so tsc still runs, and the one-bit leak that decision accepted stands for those routes.
- `{"files":[]}` used to fail the check with `nothingToCheck`. It now gives a TS18002 finding, which is pre-existing, and so advisory, when the base has the same project.
- A project that names a file under `node_modules`, whose entries in the worktree link to the checkout's install, is refused. tsc's default `exclude` keeps `node_modules` out of `include`, and Melian's own project lists none.
