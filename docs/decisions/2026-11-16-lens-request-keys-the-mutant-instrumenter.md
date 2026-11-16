# A lens run offered `list_mutants` keys the instrumenter that answers it

Amends: [Lens runs are reused per request](2026-11-15-lens-runs-reused-per-request.md), what a lens run's request holds

Status: for [issue #241](https://github.com/melian-agent/melian/issues/241), on [pull request #492](https://github.com/melian-agent/melian/pull/492). The coordinator chose this on 2026-11-16, in a message to the builder, as a choice of approach, not a ruling, and told the maintainer.

## Problem

`list_mutants` asks Stryker's installed instrumenter, `@stryker-mutator/instrumenter`, which mutants sit on a file's changed lines. The tool prefers the checkout's install and falls back to Melian's own. A lens run's request held the tool's name, description, schema and limits, but not which instrumenter answers it. Lens reuse copies a run whose request matches. Example: a review of a head runs the `tests` lens, which lists the mutants of one file. The checkout then upgrades the instrumenter, which adds a mutator. A second review of the same head copies the first run, so the lens never sees the new mutants or the test gaps they show. Codex's adversarial review found it at 8bde6b0a.

## Choice

For a run offered `list_mutants`, the request holds the instrumenter: its version, read from the `package.json` of the package the tool resolves, and its source, `checkout` or `melian`. When neither resolves, it holds `unavailable`. `TypeScriptMutationAdapter.open` resolves the package for both the tool and the key, so the key reads what the tool runs. The review resolves it once, and only when a selected lens is offered the tool. A run that is not offered the tool keys nothing more, so its request, and every stored run's key, is unchanged byte for byte.

## Why

The ruling of 2026-11-15 that [the per-request decision](2026-11-15-lens-runs-reused-per-request.md) records leaves the lens tools' own code out of the key until [issue #437](https://github.com/melian-agent/melian/issues/437). That covers `list_mutants`'s own code, which stays out. The instrumenter is not Melian's code. It is an installed package whose version decides what a lens is shown, the reason the same decision keys the installed versions of Pi Durable and pi-ai. Keying it can only narrow reuse: at worst a `tests` lens that could have been copied runs again after an upgrade. Leaving it out would let a run that saw another list stand. Rule 5 of [the identity guideline](../guidelines/identity.md#rules) says to include when unsure.

## Limits

The key does not hold the instrumenter's own dependencies, such as Babel. A reinstall that moves Babel but leaves the instrumenter's version alone can change the mutants the tool lists, and a later review of the same head then copies a run that saw the older list. The maintainer's ruling of 2026-11-16 on this is [recorded on the pull request](https://github.com/melian-agent/melian/pull/492#issuecomment-6907598594), and [issue #470](https://github.com/melian-agent/melian/issues/470) tracks it with the packages beneath pi-ai. The key does not hold the base's Stryker exclusions either: the base is in the key already, and the tool reads them from it.

The tool reads those exclusions from the merge base. [The mutation evidence decision](2026-10-24-mutation-evidence-by-enumeration-and-verification.md) names the policy source the host chose. When the two commits differ, the tool can leave out mutants that the policy source would list, or list ones it would leave out. Both commits are on the base side, so a head cannot switch its own mutants off. The same ruling, [recorded on the pull request](https://github.com/melian-agent/melian/pull/492#issuecomment-6907598594), covers this, and [issue #503](https://github.com/melian-agent/melian/issues/503) carries the policy commit to the tool.

The review resolves the instrumenter once to build the key, and `list_mutants` resolves it again each time it runs. An instrumenter that changes during one review, across a crash and replay, can therefore leave that run stored under the key that names the old one, and a later review could copy it. Closing it means the tool checks the instrumenter it resolves against the one the run was keyed with. The lens task stores only the request's hash, so that identity needs a field on the task's stored run, and a new field takes a task version that [issue #493](https://github.com/melian-agent/melian/issues/493) and [issue #489](https://github.com/melian-agent/melian/issues/489) already claim. The maintainer's ruling of 2026-11-16 on this is [recorded on the pull request](https://github.com/melian-agent/melian/pull/492#issuecomment-6907010904), and [issue #503](https://github.com/melian-agent/melian/issues/503) adds that field after them.

`list_mutants` runs one enumeration at a time in the process, and the queue holds only work that is already bounded: `list`, which refuses to start past its deadline and ends its worker there. A call opens its review's enumeration before it joins the queue. That setup resolves the changeset with git commands that have no deadline, as Melian's other lens tools' git commands have none. A stalled one holds only its own review's calls, which share its open, never another review's.
