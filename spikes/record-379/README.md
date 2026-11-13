# Review with tests: the shared record decision's import and gate

For [issue #379](https://github.com/melian-agent/melian/issues/379), reviewing sections 8 and 9 of the decision proposed in [pull request #377](https://github.com/melian-agent/melian/pull/377). Scripts, not product code. They change nothing under `packages/` or `docs/`, and run on the fake model only.

Run from the checkout, after `npm ci`, with `MELIAN_STATE_DIR` unset:

```bash
node --experimental-strip-types --no-warnings --conditions=@melian-agent/source --test spikes/record-379/cases.test.ts
```

- `cases.test.ts` holds one test per case. A test whose name starts with `FINDING` asserts what the code does where that differs from what the decision states, or where the decision says nothing.
- `gate.ts` is the gate of section 9 and the import rules of sections 5 and 8, as the decision words them. Each rule the decision leaves open is marked `READING`.
- `verdict.ts` is `spikes/record-373/verdict.ts` with two changes: the reopen rule takes each revision's proving hunks from git, and trust is a predicate.
- `scenario.ts` runs real reviews across heads, as `spikes/record-373/run.ts` does.
- `spikes/record-372` and `spikes/record-373` are copied unchanged from their spike branches, since these scripts import them.
