---
name: trust-boundary-probes
extends: trust-boundary
emoji: "\U0001F52C"
levels:
  quick: { budget: { tokens: 1m } }
  deep: { probe: { prober: medium }, budget: { tokens: 3m, tools: 90 } }
budget: { findings: 8, tokens: 3m, tools: 90 }
standards: false
---
The trust-boundary lens reviews this change by reading it. This lens is its second half: it tests the boundary with probes.
