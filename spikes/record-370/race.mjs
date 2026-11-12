// Races between writers that are separate processes, each with its own clone (git) or handle (directory).
// Usage:
//   node race.mjs records git <remote> <ref> [writers=2] [each=50]
//   node race.mjs cell git <remote> <ref> [trials=5]
//   node race.mjs records dir <root> [writers=2] [each=50]
//   node race.mjs cell dir <root> [trials=50]
// A writer process runs this file with "worker" first.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openStore, recordId, Signer } from "./store.mjs";

const args = process.argv.slice(2);
const sleepUntil = (at) => new Promise((done) => setTimeout(done, Math.max(0, at - Date.now())));

if (args[0] === "worker") {
	const [, mode, kind, startAt, changeset, count, label, ...where] = args;
	const options = kind === "git" ? { remote: where[0], ref: where[1] } : { root: where[0] };
	const store = await openStore(kind, options);
	const signer = new Signer();
	await sleepUntil(Number(startAt));
	const started = Date.now();
	if (mode === "records") {
		const ids = [];
		for (let i = 0; i < Number(count); i++) {
			const record = signer.record(changeset, "check", `writer-${label}-${i}`, { label, i });
			await store.add(record);
			ids.push(recordId(record));
		}
		console.log(JSON.stringify({ ids, ms: Date.now() - started, pushes: store.pushAttempts ?? null }));
	} else {
		const won = await store.writeCell(changeset, undefined, `lease held by ${label}`);
		console.log(JSON.stringify({ won, label, ms: Date.now() - started }));
	}
	await store.close();
	process.exit(0);
}

const [mode, kind, ...rest] = args;
const where = kind === "git" ? rest.slice(0, 2) : rest.slice(0, 1);
const numbers = (kind === "git" ? rest.slice(2) : rest.slice(1)).map(Number);
const self = fileURLToPath(import.meta.url);
const run = (workerArgs) =>
	new Promise((resolve, reject) =>
		execFile(process.execPath, [self, "worker", ...workerArgs], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
			error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(JSON.parse(stdout.trim().split("\n").pop())),
		),
	);
const store = await openStore(kind, kind === "git" ? { remote: where[0], ref: where[1] } : { root: where[0] });

if (mode === "records") {
	const [writers = 2, each = 50] = numbers;
	const changeset = `spike370-race-${randomBytes(6).toString("hex")}`;
	const startAt = Date.now() + (kind === "git" ? 8000 : 500);
	const outcomes = await Promise.all(
		Array.from({ length: writers }, (_, w) => run([mode, kind, String(startAt), changeset, String(each), String(w), ...where])),
	);
	const written = outcomes.flatMap((o) => o.ids);
	const listed = (await store.list(changeset)).map(recordId);
	const missing = written.filter((id) => !listed.includes(id));
	const extra = listed.filter((id) => !written.includes(id));
	console.log(
		JSON.stringify({
			kind,
			changeset,
			writers,
			each,
			written: written.length,
			listed: listed.length,
			unique: new Set(listed).size,
			missing: missing.length,
			extra: extra.length,
			writerMs: outcomes.map((o) => o.ms),
			pushAttempts: outcomes.map((o) => o.pushes),
		}),
	);
	await store.dispose(changeset);
	process.exitCode = missing.length === 0 && extra.length === 0 && listed.length === writers * each ? 0 : 1;
} else {
	const [trials = kind === "git" ? 5 : 50] = numbers;
	const tally = [];
	for (let t = 0; t < trials; t++) {
		const changeset = `spike370-cell-${randomBytes(6).toString("hex")}`;
		const startAt = Date.now() + (kind === "git" ? 8000 : 300);
		const outcomes = await Promise.all(["A", "B"].map((label) => run([mode, kind, String(startAt), changeset, "0", label, ...where])));
		const winners = outcomes.filter((o) => o.won).map((o) => o.label);
		const { value } = await store.readCell(changeset);
		tally.push({ winners, value, agrees: winners.length === 1 && value === `lease held by ${winners[0]}` });
		await store.dispose(changeset);
	}
	console.log(JSON.stringify({ kind, trials, exactlyOne: tally.filter((t) => t.agrees).length, tally }));
	process.exitCode = tally.every((t) => t.agrees) ? 0 : 1;
}
await store.close();
