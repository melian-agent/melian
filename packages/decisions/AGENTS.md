# Working in packages/decisions

@../../docs/guidelines/decisions.md

## Rules

- Implement core's `Decider` port and parse the written decisions for the design lens. Which adapter answers, and when, is the host's choice; the pipeline runs every decision as a durable task.
- Never import Pi, pi-ai, or `@melian-agent/pipeline`. The LLM fallback asks a model through core's `TextModel` port, which the pipeline implements over a review's models.
- An adapter that cannot answer throws, so its caller fails closed. Never invent an answer, a default distribution included.
- Validate what a model returns against the tool's schema before it leaves the adapter. Core's `Decision.parse` checks the answer against the questions.

## Running the tests

- Whole package: `npm test --workspace @melian-agent/decisions`. The adapters are tested against a stub text model here; the LLM fallback on the fake model runs in the pipeline's `test/triage.test.ts`.
