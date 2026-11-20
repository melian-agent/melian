# Builders bring every question for the maintainer through the coordinator

Amends: [Builders ask the coordinator first, and a question is written for a reader without context](2026-11-13-builders-ask-the-coordinator-first.md), its 30-minute fallback to the maintainer, and where a builder asks for a read of findings or notices.

Status: the maintainer ruled on 2026-11-17, in the coordinator's session: "can you inform the builders to raise questions to me only through yourself". He agreed the same day, in the same session, to record it in `AGENTS.md` with this file.

## Problem

`AGENTS.md` sent a builder to the maintainer in its own session in three places: when the coordinator had not answered within 30 minutes, when the round raised acknowledge findings before the builder marked its pull request ready, and for a read of policy notices. The host finishers did the same.

Example: several builders each asked the maintainer to read acknowledge findings, in sessions that held none of the others' context.

## Decision

1. A builder never asks the maintainer in its own session. Every question, and every request for a read of acknowledge findings or policy notices, goes to the coordinator in a message to its session.
2. The coordinator takes it to the maintainer and returns the answer, saying whether it is a ruling. The host finishers follow the same rule.
3. If the coordinator has not answered within 30 minutes, the builder asks it again and keeps working on anything that does not depend on the answer.
4. The builder still records the question and the answer on the issue or pull request, and says who gave it. A coordinator's answer is not a ruling.
5. An instruction the maintainer gave a builder directly in that builder's session stands until the maintainer changes it there. A relayed message does not override it.

## Why

The coordinator's reading, not the maintainer's: a dozen sessions each asking for reads and rulings scattered the maintainer's attention, and the same question reached him in different words. One channel lets the coordinator join those questions and answer what a ruling already settles.

## What it gives up

A builder whose coordinator is out of reach waits longer than the 30 minutes the earlier decision allowed.
