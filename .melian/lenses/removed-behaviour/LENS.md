---
name: removed-behaviour
extends: removed-behaviour
levels:
  quick: { tier: light }
handoffs:
  durability: A write, an effect, a key, or a stored shape that goes wrong only with a crash, a restart, a replay, a resumed or superseded task, or a record an earlier run stored, even when the change deleted or moved the line that prevented it.
budget: { findings: 8, tokens: 3000000, tools: 150 }
---
