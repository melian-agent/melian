# The design lens may make 250 tool calls

Choice: In Melian's own repository, `.melian/lenses/design/LENS.md` gives the design lens a budget of 250 tool calls, up from 150. Its findings and token budgets are unchanged.

Why: On [pull request #215](https://github.com/melian-agent/melian/pull/215) at e76de3b6, the design lens ran out of its 150 tool calls after 1,327,762 tokens, so the round read not reviewed, while Codex's adversarial review approved the same head. A lens cut by its budget is never a clean round, and a round override can't raise a committed lens's budget, because Melian reads lens policy from the base. The maintainer ruled on 2026-10-27 to raise the committed budget. The token budget still bounds what a round can spend.

Amends: [2026-10-24-design-lens-on-codex-route.md](2026-10-24-design-lens-on-codex-route.md), the design lens's tool-call budget
