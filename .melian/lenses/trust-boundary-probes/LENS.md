---
name: trust-boundary-probes
extends: trust-boundary
levels:
  deep: { probe: { prober: medium }, budget: { tokens: 600000, tools: 90 } }
budget: { findings: 8, tokens: 600000, tools: 90 }
---
The trust-boundary lens reviews this change by reading it. This lens is its second half: it tests the boundary with probes.
