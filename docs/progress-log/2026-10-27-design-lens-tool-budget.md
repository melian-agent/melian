# 2026-10-27: the design lens may make 250 tool calls

[Pull request #215](https://github.com/melian-agent/melian/pull/215)'s round at e76de3b6 read not reviewed because the design lens ran out of its 150 tool calls. The maintainer ruled to raise the committed budget to 250, as [the decision](../decisions/2026-10-27-design-lens-tool-budget.md) records. Rounds on #215 and later pull requests read the new budget once this lands on main and they merge it.
