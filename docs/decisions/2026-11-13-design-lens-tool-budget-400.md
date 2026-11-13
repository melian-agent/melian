# The design lens may make 400 tool calls, within 5,000,000 tokens

Amends: [The design lens may make 250 tool calls](2026-10-27-design-lens-tool-budget.md), the tool-call and token budgets

Choice: In Melian's own repository, `.melian/lenses/design/LENS.md` gives the design lens a budget of 400 tool calls, up from 250, and 5,000,000 tokens, up from 3,000,000. Its findings budget is unchanged.

Why: On [pull request #296](https://github.com/melian-agent/melian/pull/296) at `e1280f1a`, the design lens ran out of its 250 tool calls after 2,307,215 tokens, so the host round read not reviewed. A lens cut by its budget is never a clean round, and Melian reads a pull request's lens budgets from its base, so no override can raise one for a round. The maintainer ruled on 2026-11-13, in the coordinator's session, to raise the tool budget. The figures are the coordinator's: 400 is the earlier raise's step again, and the token budget rises with it because 400 calls at that round's rate would pass 3,000,000 tokens.

The conventions lens's findings budget rises from 16 to 24 in the same change. That is the coordinator's choice, not part of the ruling, and no decision fixed the earlier figure.
