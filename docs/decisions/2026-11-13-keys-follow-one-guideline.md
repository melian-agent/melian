# Every key follows one guideline, and a brief asks about keys

Status: ruled by the maintainer on 2026-11-13, in the coordinator's session. The maintainer asked how guidance could make builders weigh key design closely, and accepted the coordinator's proposal of a guideline and a question in every brief. The shared key function and its guardrail are proposed with [pull request #377](https://github.com/melian-agent/melian/pull/377), not ruled here.

## Problem

Many of the review loop's repeated findings are one class: a key that decides reuse or sameness was designed where it was needed, from a list of inputs its author thought of. The design lens reports the class, under `identity-missing-input` and `resumed-identity`, but nothing made a builder think about it before writing the code.

Example: the lens task's attach key on [pull request #296](https://github.com/melian-agent/melian/pull/296) drew a finding in six fix passes. A survey of `main` at `a045356a` found 68 direct hash calls in 28 source files and about 35 keys, no two assembled the same way, and four cases of one thing with two keys.

## Decision

1. [The identity guideline](../guidelines/identity.md) holds the rules for a key, the tests one needs, and a table of every key Melian has: what a match decides, and what is left out and why.
2. Root `AGENTS.md` points every package at it, and the pipeline and core packages import it.
3. A brief asks whether the work adds or alters a key. When it does, the pull request's description carries the key's table row, and the row changes in the same commit.

## Why

A rule a builder reads before the work costs less than a round that finds its absence after. The table is what makes the rule checkable: a reviewer reads one row against the code, and a builder about to write a key finds the one that already exists.

## What it gives up

The table is written by hand and can drift from the code until the shared key function exists. The survey behind it was read from the source by an agent and spot-checked by the coordinator, not proved row by row.
