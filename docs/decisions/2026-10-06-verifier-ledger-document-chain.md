# Keep one verdict-document version chain

Date: 2026-10-06

Problem: [pull request #80](https://github.com/melian-agent/melian/pull/80) adds optional verification data to version 3 verdicts. The ledger from [pull request #73](https://github.com/melian-agent/melian/pull/73) writes version 5.

Example: reopening a verifier-era verdict must preserve its refuted group and verifier provenance while allowing ledger details to be written.

Decision: retain version 5. VerdictState.upgrade reads every older version through Verdict.upgrade. Version 1 keeps its head-only keys. Version 2 uses base-and-head keys. Version 3 upgrades evidence and permits optional verification data. Version 4 adds run details and walkthroughs. Version 5 separates fallback notes. Migration preserves provenance, decisions and verification data without filling absent optional fields.

A version 1 record carries no base or publication provenance. Keeping it readable never invents either. A fresh review is required before publication. SQLite regressions reopen every version, write the current shape and check the fingerprint and stored judgements.
