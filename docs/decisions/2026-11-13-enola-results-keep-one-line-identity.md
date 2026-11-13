# An Enola result keeps the identity of the line it starts on

Amends: [Finding identity](2026-10-03-finding-identity.md), for Enola results alone: the snippet is the line a result starts on, not every line its region spans.

Status: ruled by the maintainer on 2026-11-13, in the builder's session for [issue #346](https://github.com/melian-agent/melian/issues/346), choosing option A of the question on that issue. The coordinator had not answered within 30 minutes; it later agreed. The maintainer ruled on the trigger and on dismissals across versions the same day, in the coordinator's session, after the rounds on [pull request #385](https://github.com/melian-agent/melian/pull/385) raised them.

## Problem

`staticFindings` identifies a static result by the code between its SARIF `startLine` and `endLine`, so a later push can tell a result it has seen from a new one. Enola 0.4.27 gave every TypeScript result one line, where its symbol is declared. From 0.4.37 (upstream commit b0026f5), Enola gives TypeScript symbols their whole span and writes it as `region.endLine`.

Example: on the range of [pull request #339](https://github.com/melian-agent/melian/pull/339), `enola/complexity-outliers` on `ReviewPlan.resolveRoute` moved from lines 304–304 to 304–433, and its finding ID changed. An edit anywhere inside a flagged function would then make its result read as `introduced` instead of `pre-existing`, and every stored Enola dismissal would reset once.

## Decision

`staticFindings` hashes only the line an Enola result starts on, as under 0.4.27. The finding records Enola's whole span as its region, and an introduced Enola finding takes its trigger from that span, by the maintainer's ruling of 2026-11-13 in the coordinator's session. A dismissal therefore reopens when the code behind the finding changes, its body included.

Under 0.4.27 a finding that a body edit introduced had no trigger, since Enola named the declaration line alone and no hunk touched it. Its dismissal never reopened, however the body changed. The span closes that gap, which predates this upgrade. Dismissed Enola findings will reopen more often than before.

A dismissal carries across Enola versions, as it does for every static tool, whose finding IDs name no tool version. The maintainer ruled so on 2026-11-13, in the coordinator's session. On the eight past merges compared for [pull request #385](https://github.com/melian-agent/melian/pull/385), every Enola finding was advisory or silent.

## Why

[Issue #346](https://github.com/melian-agent/melian/issues/346) asks that Enola-backed checks behave the same after the upgrade. Span identity would be a change of what counts as new, and belongs in its own issue with its own measurement.

## What it gives up

An Enola result whose body changed reads as pre-existing, exactly as before; only its dismissal reacts to the body. Span identity, if wanted later, needs a migration note: every stored Enola finding ID changes once.
