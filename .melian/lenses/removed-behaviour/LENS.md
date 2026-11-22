---
name: removed-behaviour
extends: removed-behaviour
levels:
  quick: { budget: { tokens: 1m, tools: 30 } }
  deep: { budget: { tokens: 3m, tools: 90 } }
handoffs:
  durability: A write, an effect, a key, or a stored shape that goes wrong only with a crash, a restart, a replay, a resumed or superseded task, or a record an earlier run stored, even when the change deleted or moved the line that prevented it.
budget: { findings: 8, tokens: 3m, tools: 90 }
standards: false
---
