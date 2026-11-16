// Usage: node run.mjs <worktree at 4c2941b6> <mutated file> <out.jsonl> [scratch directory]
// Runs each owed mutant of one file against one named test at a time. See README.md.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
const here = dirname(new URL(import.meta.url).pathname);
const [wt, target, out, scratch = mkdtempSync(join(tmpdir(), "mutants-"))] = process.argv.slice(2);
const same = spawnSync("git", ["diff", "--quiet", "4c2941b6", "HEAD", "--", ".", ":(exclude)tmp-mutants"], { cwd: wt }).status === 0;
if (!same) { console.error(`${wt} differs from 4c2941b6 outside tmp-mutants/; check it out at 4c2941b6 or at scratch/pr-476-mutants`); process.exit(2); }
if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no", "--", "packages"], { cwd: wt, encoding: "utf8" }).trim()) { console.error(`${wt} has changes under packages/`); process.exit(2); }
const shard = "0";
const S = scratch;
const inv = JSON.parse(readFileSync(join(here, "inventory.json"), "utf8"));
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);
const done = new Set([...readdirSync(here).filter((f) => f.startsWith("proved-") && f.endsWith(".jsonl")).flatMap((f) => lines(join(here, f))), ...lines(out)]);
const hints = {};
const mine = inv.mutants.filter((m) => m.status === "generated" && inv.claimsIn.includes(m.file) && m.file === target);
const p = (pkg) => (n) => `packages/${pkg}/test/${n}.test.ts`;
const core = p("core"), pipe = p("pipeline");
const candidates = {
	"packages/core/src/record.ts": ["record", "record-set", "record-payloads", "review-payloads", "record-store"].map(core),
	"packages/core/src/record-payloads.ts": ["review-payloads", "record-payloads", "record-set"].map(core),
	"packages/cli/src/commands.ts": ["packages/cli/test/cli.test.ts"],
	"packages/pipeline/src/recorded-round.ts": ["recorded-round", "review-records", "review-records-export"].map(pipe),
	"packages/pipeline/src/findings.ts": ["recorded-round", "review-records", "review-records-export", "findings"].map(pipe),
	"packages/pipeline/src/review-records.ts": ["review-records", "review-records-export", "recorded-round"].map(pipe),
	"packages/core/src/config.ts": ["config", "review-payloads"].map(core),
	"packages/pipeline/src/summarize.ts": ["summarize", "review-records-export", "walkthrough-request"].map(pipe),
	"packages/pipeline/src/review.ts": ["review-records-export", "recorded-round", "plan", "probing-level", "lens-reuse-review", "review"].map(pipe),
};
const filter = { "packages/cli/src/commands.ts": ["-t", "record|trust"] };
const whole = (file) => (file.startsWith("packages/cli/") ? undefined : file.split("/").slice(0, 2).join("/"));
const env = { ...process.env };
delete env.MELIAN_STATE_DIR;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function vitest(files, extra) {
	const json = `${S}/vt476-${shard}.json`;
	rmSync(json, { force: true });
	const r = spawnSync("npx", ["vitest", "run", ...files, "--reporter=json", `--outputFile=${json}`, ...extra], { cwd: wt, env, encoding: "utf8", timeout: 1_200_000, maxBuffer: 64 << 20 });
	if (!existsSync(json)) return { timedOut: r.error?.code === "ETIMEDOUT" || r.signal !== null, results: [] };
	const report = JSON.parse(readFileSync(json, "utf8"));
	const results = report.testResults.flatMap((f) => f.assertionResults.map((a) => ({ file: f.name.slice(wt.length + 1), ancestorTitles: a.ancestorTitles, title: a.title, status: a.status })));
	return { timedOut: false, results, loadFailed: report.testResults.some((f) => f.status === "failed" && f.assertionResults.length === 0) };
}
function alone(test) {
	const pattern = `^${escape([...test.ancestorTitles, test.title].join(" > "))}$`;
	const r = vitest([test.file], ["-t", pattern]);
	const ran = r.results.filter((x) => x.status === "passed" || x.status === "failed");
	return { collected: ran.length, status: ran.length === 1 ? ran[0].status : undefined, timedOut: r.timedOut };
}
const unmutated = new Map();
function cleanPass(test) {
	const k = JSON.stringify(test);
	if (!unmutated.has(k)) unmutated.set(k, alone(test));
	return unmutated.get(k);
}
function apply(m) {
	const path = `${wt}/${m.file}`;
	const text = readFileSync(path, "utf8");
	const lines = text.split("\n");
	const offset = (line, col) => lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + col;
	writeFileSync(path, text.slice(0, offset(m.line, m.column)) + m.replacement + text.slice(offset(m.endLine, m.endColumn)));
	return () => writeFileSync(path, text);
}
for (const m of mine) {
	if (done.has(m.id)) continue;
	const started = Date.now();
	const record = { id: m.id, file: m.file, line: m.line, column: m.column, mutatorName: m.mutatorName, replacement: m.replacement };
	const restore = apply(m);
	try {
		let killer;
		const excluded = [];
		const hint = hints[m.id];
		if (hint) {
			restore();
			const clean = cleanPass(hint);
			apply(m);
			if (clean.collected === 1 && clean.status === "passed") {
				const mutated = alone(hint);
				if (mutated.collected === 1 && (mutated.status === "failed" || mutated.timedOut)) killer = { ...hint, status: "failed", mutated: mutated.timedOut ? "timeout" : "failed", hinted: true };
				else record.hintSurvived = true;
			} else record.hintRejected = clean;
		}
		const stages = [candidates[m.file], ...(whole(m.file) ? [[whole(m.file)]] : [])];
		for (let round = 0; killer === undefined && round < 8; round++) {
			const files = stages[0].filter((x) => !x.endsWith(".ts") || !excluded.includes(x));
			if (files.length === 0) { stages.shift(); if (stages.length === 0) break; continue; }
			const file = files.join(" ");
			const r = vitest(files, ["--bail=1", ...(filter[m.file] ?? []), ...excluded.flatMap((x) => ["--exclude", x])]);
			if (r.timedOut) { record.timedOutIn = file; break; }
			const failed = r.results.find((x) => x.status === "failed");
			if (failed) {
				restore();
				const clean = cleanPass(failed);
				apply(m);
				excluded.push(failed.file);
				if (clean.collected !== 1 || clean.status !== "passed") { record.rejected = (record.rejected ?? []).concat({ ...failed, clean }); continue; }
				const mutated = alone(failed);
				if (mutated.collected === 1 && (mutated.status === "failed" || mutated.timedOut)) { killer = { ...failed, mutated: mutated.timedOut ? "timeout" : "failed" }; break; }
				record.rejected = (record.rejected ?? []).concat({ ...failed, mutated });
			}
			if (r.loadFailed && !failed) record.loadFailed = (record.loadFailed ?? []).concat(file);
			if (!failed) { stages.shift(); if (stages.length === 0) break; }
		}
		record.killer = killer;
	} finally {
		restore();
	}
	const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no", "--", "packages"], { cwd: wt, encoding: "utf8" }).trim();
	if (dirty) { console.error(`dirty after ${m.id}: ${dirty}`); process.exit(2); }
	record.seconds = Math.round((Date.now() - started) / 1000);
	appendFileSync(out, `${JSON.stringify(record)}\n`);
	console.log(`${m.file.split("/").pop()}:${m.line}:${m.column} ${m.mutatorName} ${record.killer ? "killed" : "SURVIVED"} ${record.seconds}s`);
}
