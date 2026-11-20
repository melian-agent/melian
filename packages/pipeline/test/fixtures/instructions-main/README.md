# Main's state at findings version 12

`review.json` was recorded at `16c0d89cbfba8932a2f1def37331988571a11cc3`, the `main` that [issue #565](https://github.com/melian-agent/melian/issues/565) merged once [pull request #579](https://github.com/melian-agent/melian/pull/579) had taken findings version 12 for check-run stamps. It uses that commit's version-12 findings, version-15 verdict, version-11 publication and version-4 rounds definitions. The recording used memory storage and the fake model, with no model requests.

It holds the same review as `../instructions-previous/`: a policy notice on `prompts/brief.md` and a lens's `melian/injection-attempt` finding on the same file. That commit's notice names no instruction file, so the injection finding is held at acknowledge.

The recording script is `record.ts`, run as `node --conditions=@melian-agent/source packages/pipeline/test/fixtures/instructions-main/record.ts <commit>` from the root of a checkout at the recorded commit. Run it only against that commit's production code. No old shape was invented by hand.
