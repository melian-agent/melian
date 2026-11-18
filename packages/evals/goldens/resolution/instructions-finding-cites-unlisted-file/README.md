# A finding that names a listed file and an unlisted one is reported whole

The root `melian.yaml` lists `src/prompts.ts`, and the change rewrites the brief it holds. A lens reports `melian/injection-attempt` there and cites `src/run.ts`, which the list leaves out, as evidence. A notice covers only its own file, so the finding is reported whole and blocks, and the notice on `src/prompts.ts` quotes nothing.
