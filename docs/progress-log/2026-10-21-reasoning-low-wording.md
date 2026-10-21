# Wording fixes after the reviews of the low-reasoning change

Two reviews of [pull request #159](https://github.com/melian-agent/melian/pull/159) agreed the numbers were right and asked for plainer claims. Docs only.

- The plan marks the two accepted below-bar results: contracts recall 0.50 against 0.6, and Opus design precision 0.75 against 0.8.
- The decision gives the effect of one finding per corpus, says contracts moves recall by 0.50 per finding, and says triage's gain is one golden, `add-test-only`.
- It no longer claims what unset sends for Sol; no cell measured it. It states what the off cell saw: Terra `effort: none`.
- Speed is 10% over all 68 goldens and 13% over the five original corpora. The review asked for 9% and 12%; the per-golden means in the raw files give 31.9 against 35.4 seconds and 32.5 against 37.1.
- The record says the Opus cells used the Terra verifier and the Sol cells Sonnet.
