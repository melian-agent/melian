# Lenses are not shown mutation inventories

Status: the maintainer ruled on 2026-11-18, in the coordinator session, that Melian's own `melian.yaml` stop showing mutation inventories, the JSON files under `docs/progress-log/`, to every lens, by a change of its own that the maintainer reads. Guardrails and static checks still see the files.

## Problem

A pull request that changes trust code commits a mutation inventory: a large JSON file of data a builder wrote, not code. Every lens is shown the changed files in its prompt, so an inventory is shown to every lens.

Example: [pull request #532](https://github.com/melian-agent/melian/pull/532) added 11,500 lines. Inventories were 9,256 of them (80%); source and tests were about 1,500. Each lens's first request ran to about 250,000 tokens before it read anything. The probe planner of `lens.trust-boundary-probes` spent its whole 600,000-token budget after 2 tool calls, and `lens.design` ran out at 5 million. The round read "not reviewed".

## Rule

Each lens the root `melian.yaml` configures has `"!docs/progress-log/*.json"` in its `paths`, beside the exclusions for the golden corpus. A file that matches is covered by no lens: it is not in any lens's prompt, and no lens reads or reports on it. A `.md` entry in the same folder, and a `.json` file anywhere else, are still covered. `durability` sets its own paths, source folders only, so it never covered the folder. The guardrails and the static checks do not read lens paths, so they see the files as before.

A pull request whose only changed file is an inventory runs no lens. Each lens reads "skipped: no paths", which a round counts as an allowed skip, so the round can pass.

## Why

A lens's budget is for the change. An inventory is the builder's record of mutants, not behaviour a lens can judge, and showing it spends the budget before the lens reads the source and tests the inventory describes.

## Limit

No lens reviews a builder's claims in an inventory. Those claims are checked only by the review of record's sample, `node scripts/enumerate-mutants.mjs --sample`, which reruns a selection of the recorded mutants. A false claim in an inventory outside that sample reaches `main` unread by any lens.

This changes Melian's own repository only. The default lens paths of a repository that has its own `melian.yaml` are not touched.
