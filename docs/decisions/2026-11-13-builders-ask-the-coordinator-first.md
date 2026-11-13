# Builders ask the coordinator first, and a question is written for a reader without context

Status: ruled by the maintainer on 2026-11-13, in the coordinator's session.

## Problem

A builder that needed a decision asked the maintainer in its own session. Every question reached the maintainer, the ones a ruling already settled included, and each arrived in a different session, worded for someone who had followed that session's work.

Example: on [pull request #296](https://github.com/melian-agent/melian/pull/296) a round found a sixth instance of one class of defect. The coordinator already held the earlier rulings on that class and a rule just adopted for it elsewhere, yet the question had to go to the maintainer to be answered.

## Decision

1. A builder asks the coordinator first, in a message to its session.
2. The coordinator answers what a ruling or `AGENTS.md` already settles, and choices of approach. A new ruling, a change to a decision, and anything that changes trust or blocking behaviour stay the maintainer's, and the coordinator takes them to the maintainer.
3. If the coordinator has not answered within 30 minutes, the builder asks the maintainer in its own session. A builder never waits on a coordinator that is not there.
4. A question is written for a reader who has none of the asker's context: what the pull request does, what happened, the choice, what each option costs, and a recommendation, in plain words. The coordinator writes the same way to the maintainer.
5. The answer is recorded on the issue with who gave it. A coordinator's answer is not a ruling, and no comment states it as one.

## Why

The coordinator sees every lane, so it can answer from a ruling made in another lane, and can spot one class of question arriving from two builders. The 30-minute fallback keeps a builder's independence: the issue, the repository and GitHub are still all it counts on.

The 30 minutes is the coordinator's figure, not part of the ruling.

A question that assumes its reader's context costs a round trip to decode, or draws an answer to a different question.

## What it gives up

A question the coordinator must pass on takes one more hop than before.
