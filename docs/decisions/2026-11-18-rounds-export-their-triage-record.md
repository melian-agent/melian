# A round exports its triage record

Status: records what [pull request #566](https://github.com/melian-agent/melian/pull/566) built for [issue #554](https://github.com/melian-agent/melian/issues/554). It is not a maintainer's ruling.

Amends: [One class decides which skips let a review pass](2026-11-17-tier-account-decides-allowed-skips.md), the paragraph that says no round exports a triage record yet.

## Problem

The amended decision said no round exports a triage record, so a reader on another machine refused every account that allowed a triage skip. Pull request #566 made rounds export the record, and edited that paragraph in place, where a merged decision is changed only by a new file.

## Decision

A round exports its triage record when it asked triage. The round names it, and its account counts it, so the account's key commits to triage's decision and to whether its input was cut. A reader that checks an account from shared records reads triage's choices from that record.

A round whose records name no triage record, such as one an earlier build wrote, has none to read. A reader refuses an account of it that allows a triage skip, which fails closed.
