# 2026-10-24: findings render in the register, part 1

[Pull request #201](https://github.com/melian-agent/melian/pull/201) builds the visible half of plan step 35, [issue #197](https://github.com/melian-agent/melian/issues/197). The terminal and the pull-request comment now open with the status line from [the findings guideline](../guidelines/findings.md), print the headline once, and leave out any part a finding lacks. Evidence names locations and no longer quotes code. `packages/core/src/emoji.ts` holds the table as escapes, and `biome/literal-emoji.grit` refuses a literal emoji in any source, test or script literal. `output.emoji` and `publish.emoji` switch the emojis, and a `LENS.md` may declare its own.

The headline repeats What because `report_finding` stores What as the message. The renderers now print that sentence once and leave the stored shape alone. A refuted protected finding renders at its trust-floor minimum with that minimum's note, and a silent floor stays hidden.

Two things wait for part 2, since each changes a stored shape or a prompt. The check record does not yet keep a lens's declared emoji, so `melian findings` and publication show the table's row or the magnifying glass for a repository lens. The review body's summary and the ledger keep their wording, and the ledger keeps words alone.

The mutation inventory listed 424 mutants on the branch, and each ran by hand against its tests. 413 are killed and 9 are equivalent, with reasons. Two sit on pre-existing lines with no test: `historical` on a frozen round, and the provider options `gitHubFor` passes, which need a GitHub token.
