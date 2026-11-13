# Review with tests: the shared record decision's trust, markers and publication

Scripts for [issue #380](https://github.com/melian-agent/melian/issues/380), which tests [the decision](https://github.com/melian-agent/melian/blob/docs-shared-record/docs/decisions/2026-11-13-shared-record-behind-a-store-port.md) proposed in [pull request #377](https://github.com/melian-agent/melian/pull/377), sections 6, 7, 10, 11 and 12. They are not product code. They use Node built-ins, Octokit, and the fake GitHub in `packages/github/test/fixtures/fake-github.ts`. Keys are generated in the test and never written.

- `stores.mjs`: the envelope's canonical bytes, its rule-3 shape check, and a git adapter and a directory adapter written to rules 3 and 12, from the adapters on `spike/record-370`. `localRemote()` is a bare repository on disk whose hooks wait as long as a file says, which stands in for GitHub's push time.
- `store370.mjs`: the #370 adapter, unchanged, for the one test that compares its cell version with rule 3's.
- `rules.mjs`: rule 4's standing set, rule 6's adding job (as worded, and a stricter one), and rules 10 and 11's publisher for the ledger comment, with crash points.
- `publish.test.mjs`: cases 1, 2, 3, 4b and 5.
- `store.test.mjs`: cases 4, 7 and 9.
- `trust.test.mjs`: cases 6 and 8.

A test that asserts a finding says `FINDING` beside the assertion. Each passes when the code behaves as the report says.

```bash
node --experimental-strip-types --no-warnings --test --test-concurrency=1 spikes/record-380/publish.test.mjs spikes/record-380/store.test.mjs spikes/record-380/trust.test.mjs
```

The store tests take about 80 seconds, most of it in case 7e's 3.3-second pushes. The report is on the issue.
