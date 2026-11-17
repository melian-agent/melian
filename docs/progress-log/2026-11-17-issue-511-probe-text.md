# Issue #511: probe text leaves telemetry for the results file

The Actions round on 3c28241d blocked on a P1 from `lens.design`, `contradicts-documented-decision`, ID `117d0794c5b360ba`. [Issue #511](https://github.com/melian-agent/melian/issues/511) asked for each prober's plan, skip reasons and probe text in the results file, and 625fdc29 put them on the telemetry stage. The telemetry decision says telemetry stores no prompts, completions, whole payloads or credentials, and `melian review --json` and `melian telemetry` print the stage, so the text reached every telemetry reader. The coordinator chose to bring the code back under that decision rather than amend it.

A prober's stage again holds counts, the attacks it skipped by number, and each probe's ID, attack, exit code, signal, time and ending. A skip's reason is the model's free text, so it goes with the content. `TelemetryReader.proberRecord` reads a prober stage's plan, skip reasons and probe scripts, files and output from the store. The eval runner reads it for every prober stage before the in-memory store closes, on a review and on a review that fails, and the probing measurement writes it to `MELIAN_EVAL_PROBE_OUT` alone, under `probers`, by stage ID.

The results file therefore holds probe output, which can include any file `probe.read` allows. It is a local file and never an artefact.

Test first. A new case in `packages/cli/test/probing-review.test.ts` runs `melian review --json` and `melian telemetry --json` on a probing review and failed at 3c28241d with the plan's text in the review's JSON. It passes with the fix. The pipeline's telemetry test now holds the stage to its counts and the record to the text, and `goldens.test.ts` holds a golden run, and its failure, to the record.

The [mutant inventory](2026-11-17-issue-511-probe-text-mutants.json) lists all 45 mutants of `3c28241d...ac6a46eb`. A scratch runner applied each of 44 and ran its named test alone. 43 were killed, two of them by a case added after the first run, a prober stage whose conversation holds no probing record. One is equivalent, with its reason. One string literal is ignored by configuration.
