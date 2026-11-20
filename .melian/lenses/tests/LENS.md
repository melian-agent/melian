---
name: tests
extends: tests
levels:
  quick: { budget: { tokens: 1m } }
  deep: { budget: { tokens: 3m, tools: 90 } }
budget: { findings: 8, tokens: 3m, tools: 90 }
---
