# Spike: sign records and decide trust from the base policy's keys

For [issue #371](https://github.com/melian-agent/melian/issues/371), under the rules of [issue #368](https://github.com/melian-agent/melian/issues/368). Scripts, not product code.

Run `node --test spikes/record-371/record.test.mjs` from the checkout, after `npm ci` for the `yaml` parser. Every key is generated at the start of the run and never written down; the scratch repository lives in a temporary directory the run deletes.
