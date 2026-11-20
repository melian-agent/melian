# Lenses get only the standards they cite

Status: the maintainer ruled on 2026-11-18, in the coordinator session, that seven of Melian's own lenses stop receiving the repository standards, that `conventions` keeps them, and that `design` loses them only if the live goldens hold. On 2026-11-20, in the coordinator session, the maintainer ruled that Melian's own `standard` tier adds `lens.conventions`. [Issue #580](https://github.com/melian-agent/melian/issues/580) records the ruling and the measurements.

## Problem

Every lens that has not opted out receives the standards chain of each file it covers: each `AGENTS.md` from the file up to the root, and each package's guideline that its `AGENTS.md` imports. In Melian's own repository that is large, and each lens pays for it on its first request before it reads any code.

Example: [pull request #532](https://github.com/melian-agent/melian/pull/532) touched every package, so a lens over `**` received 736,322 bytes of standards, about 184,000 tokens. The root `AGENTS.md` alone was 149,396 bytes, and its Learnings section 84,352 of them. `removed-behaviour`'s first request carried 231,553 uncached input tokens, and the budget counts uncached input.

The seven lenses rarely use the text. Across 301 round comments on 82 pull requests, `tests`, `durability`, `trust-boundary`, `correctness` and `trust-boundary-probes` raised 65 findings between them, and one cited a standard, which the diff itself also showed. `conventions` cited a standard in all 8 of its findings; reporting a breach of a standard is its job.

## Rule

`contracts`, `correctness`, `durability`, `removed-behaviour`, `tests`, `trust-boundary` and `trust-boundary-probes` set `standards: false` in `.melian/lenses/`. `conventions` keeps the standards. `design` sets `standards: false` too, because its goldens held without them, as the ruling required. Over the 35 design goldens on `openai-codex/gpt-6.1-sol`, recall stayed at 0.95 (19 of 20) and precision moved from 0.864 (19 of 22) to 0.826 (19 of 23). The one extra finding came from `correctness`, not `design`, and appeared in one of three runs of that golden. Its standards-dependent golden, `design-reimplements-an-authority-standard`, held. `design` cited a standard in 8 of its 245 findings over the same 82 pull requests, and only one of those needed text the diff did not show.

The full tier runs `conventions` over every path those eight cover, so a breach of a standard still has a lens to report it; the other lenses were told already that such a breach is `conventions`'s.

Melian's built-in `standard` tier, which the `pre-push` and `comment` stages run, is `fast` plus `lens.correctness` alone. With `correctness` reading no standards, it would check none. So Melian's own `melian.yaml` defines `standard` as `fast`, `lens.correctness` and `lens.conventions`, by the maintainer's ruling of 2026-11-20, in the coordinator session, [recorded on the issue](https://github.com/melian-agent/melian/issues/580). Those stages run one more lens, and its findings can block them as they do in full rounds. A test in `packages/core/test/lens.test.ts` fails when a tier of Melian's root `melian.yaml` that runs a lens runs none that reads the standards.

The change applies to Melian's own repository. A repository with its own lenses keeps the built-in default, `standards: true`.

## Why

A lens's budget is for the change. On [pull request #532](https://github.com/melian-agent/melian/pull/532), turning the standards off cut `removed-behaviour`'s first request from 231,553 to 61,791 uncached tokens, and the capped review's cost from $7.86 to $3.56.

## Limit

A lens that does not receive the standards cannot weigh a documented rule against a defect of its own kind. A `tests` finding that a standard would have made stronger is now made from the code alone. The citation count says that has been rare.

Each of the eight lenses' request keys changes once, because the key holds the standards' text, so the first review after this change runs those lenses again rather than reusing an earlier run.
