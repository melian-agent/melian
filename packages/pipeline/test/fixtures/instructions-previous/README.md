# State before instruction files

`review.json` was recorded at `814a4087cdecc284732afacfbeacfda8db8fa77d`, before [issue #565](https://github.com/melian-agent/melian/issues/565) changed production code. It uses that commit's version-11 findings, version-15 verdict, version-11 publication and version-4 rounds definitions. The recording used memory storage and the fake model, with no model requests.

The recorder stored a policy notice on `prompts/brief.md`, as that commit's guardrail writes one, and a lens's `melian/injection-attempt` finding on the same file. It read the sightings through `readFindings`, decided them with `Adjudication`, and wrote the verdict through `VerdictDocument` and `RoundWriter`. It opened `PublishedDocument` at its initial state. The JSON holds the four document snapshots. That commit's notice names no instruction file, so the injection finding is held at acknowledge.

The recording script is `record.ts`, run as `node --conditions=@melian-agent/source packages/pipeline/test/fixtures/instructions-previous/record.ts <commit>` from the checkout root. Run it only against the recorded commit's production code. No old shape was invented by hand.
