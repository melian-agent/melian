// The time one add and one list take against the remote, with no other writer. Usage:
//   node timing.mjs <remote> <ref> [runs=5]
import { randomBytes } from "node:crypto";
import { GitRecordStore, Signer } from "./store.mjs";

const [remote, ref, runs = "5"] = process.argv.slice(2);
const store = await GitRecordStore.open({ remote, ref });
const signer = new Signer();
const changeset = `spike370-timing-${randomBytes(6).toString("hex")}`;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const time = async (body) => {
	const start = process.hrtime.bigint();
	await body();
	return Number(process.hrtime.bigint() - start) / 1e6;
};
const adds = [];
const lists = [];
for (let i = 0; i < Number(runs); i++) {
	adds.push(await time(() => store.add(signer.record(changeset, "check", `timing-${i}`, { i }))));
	lists.push(await time(() => store.list(changeset)));
}
await store.dispose(changeset);
await store.close();
const round = (values) => values.map((v) => Math.round(v));
console.log(JSON.stringify({ addMs: round(adds), listMs: round(lists), medianAddMs: Math.round(median(adds)), medianListMs: Math.round(median(lists)) }));
