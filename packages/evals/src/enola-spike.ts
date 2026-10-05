import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type CallGroundTruth,
	EnolaFacts,
	EnolaImpact,
	EnolaPolicy,
	type GraphFiles,
	GraphSnapshot,
} from "@melian-agent/core";
import { backgroundContext, createNodeExecutionEnv, GraphCache, ToolProvisioning } from "@melian-agent/pipeline";
import { CompilerGraph } from "./compiler-graph.ts";
import { EnolaCoverage } from "./enola-coverage.ts";

function quote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}
/** A local measurement on a prepared, disposable copy of a trusted commit. */
export class EnolaSpike {
	readonly #tree: string;
	readonly #output: string;
	readonly #tools: ToolProvisioning;
	private constructor(tree: string, output: string, tools: ToolProvisioning) {
		this.#tree = tree;
		this.#output = output;
		this.#tools = tools;
	}
	/** Opens output under an agreed scratch directory, never loading repository-selected binaries. */
	static async open(tree: string, output: string, tools?: ToolProvisioning): Promise<EnolaSpike> {
		tree = resolve(tree);
		output = resolve(output);
		await mkdir(output, { recursive: true });
		return new EnolaSpike(
			tree,
			output,
			tools ?? (await ToolProvisioning.open(tree, { root: join(output, "cache") })),
		);
	}
	/** Measures compiler truth, explicit graph edges, resolved impact edges, and cold/warm costs. */
	async run(options: { reuseQueries?: boolean } = {}): Promise<void> {
		const env = createNodeExecutionEnv(this.#tree);
		const home = join(this.#output, "home"),
			snapshot = join(this.#output, "snapshot"),
			answers = join(this.#output, "answers");
		await mkdir(home, { recursive: true });
		await rm(snapshot, { recursive: true, force: true });
		await mkdir(snapshot, { recursive: true });
		await mkdir(answers, { recursive: true });
		const execute = async (command: string) => {
			let text = "";
			const result = await env.exec(
				command,
				{
					inheritEnv: false,
					env: {
						PATH: process.env.PATH ?? "",
						HOME: home,
						TMPDIR: process.env.TMPDIR ?? "/tmp",
						LANG: process.env.LANG ?? "en_AU.UTF-8",
					},
					timeout: 300,
					onOutput: (value) => {
						if (text.length < 8192) text += value;
					},
				},
				backgroundContext,
			);
			if (!result.ok) throw new Error(result.error.message);
			return { code: result.value.exitCode, text };
		};
		const commitResult = await execute("git -c core.hooksPath=/dev/null rev-parse HEAD");
		if (commitResult.code) throw new Error(commitResult.text);
		const commit = commitResult.text.trim();
		const treeHash = (await execute(`git rev-parse ${commit}^{tree}`)).text.trim();
		const policy = await EnolaPolicy.load(this.#tree, commit);
		const setup = await execute(`rm -rf .enola; ln -s ${quote(snapshot)} .enola`);
		if (setup.code) throw new Error(setup.text);
		await writeFile(join(snapshot, "config.yaml"), policy.toJSON().config);
		const binary = await this.#tools.binary("enola"),
			version = this.#tools.tool("enola").version;
		const config = join(snapshot, "config.yaml");
		const command = (args: string) => `env ENOLA_NO_UPDATE_CHECK=1 ${quote(binary)} ${args} ${quote(config)}`;
		const timings: { phase: string; seconds: number; peakBytes: number | null; exit: number }[] = [];
		const measure = async (phase: string, args: string) => {
			const stdout = join(this.#output, `${phase}.json`),
				stderr = join(this.#output, `${phase}.time`);
			const start = performance.now();
			const result = await execute(
				`/usr/bin/time ${process.platform === "darwin" ? "-l" : "-v"} ${command(args)} > ${quote(stdout)} 2> ${quote(stderr)}`,
			);
			const seconds = (performance.now() - start) / 1000;
			const details = await readFile(stderr, "utf8");
			const peak =
				process.platform === "darwin"
					? details.match(/(\d+)\s+maximum resident set size/)
					: details.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
			timings.push({
				phase,
				seconds,
				peakBytes: peak ? Number(peak[1]) * (process.platform === "darwin" ? 1 : 1024) : null,
				exit: result.code,
			});
			if (result.code) throw new Error(`${phase} exited ${result.code}: ${details.slice(0, 2048)}`);
			return readFile(stdout, "utf8");
		};
		await measure("generate-cold", "--generate");
		const files: GraphFiles = {
			"facts.jsonl": await readFile(join(snapshot, "facts.jsonl"), "utf8"),
			"insights.json": await readFile(join(snapshot, "insights.json"), "utf8"),
			"receipt.json": await readFile(join(snapshot, "receipt.json"), "utf8"),
			"snapshot.meta.json": await readFile(join(snapshot, "snapshot.meta.json"), "utf8"),
			"run.json": await readFile(join(snapshot, "run.json"), "utf8"),
		};
		const firstFacts = files["facts.jsonl"];
		await measure("generate-warm", "--generate");
		const factsStable = firstFacts === (await readFile(join(snapshot, "facts.jsonl"), "utf8"));
		const facts = EnolaFacts.parse(firstFacts);
		const compiler = CompilerGraph.open(this.#tree);
		let truth: CallGroundTruth;
		try {
			truth = compiler.read();
		} finally {
			compiler.close();
		}
		await writeFile(join(this.#output, "ground-truth.json"), JSON.stringify(truth));
		const target = truth.files.flatMap((file) => file.pairs).flatMap((pair) => facts.symbols(pair.callee))[0];
		if (!target) throw new Error("No queryable callee");
		const impactArgs = (name: string, file: string) =>
			`impact --json --max-depth 1 --max-nodes 500 ${quote(`file:${file} ${name}`)}`;
		for (const name of Object.keys(files)) await rm(join(snapshot, name), { force: true });
		await measure("impact-cold", impactArgs(target.name, target.file!));
		for (const [name, text] of Object.entries(files)) await writeFile(join(snapshot, name), text);
		await measure("impact-warm", impactArgs(target.name, target.file!));
		const parts = {
			tree: treeHash,
			version,
			binary: await this.#tools.cache.digest(this.#tools.tool("enola"), this.#tools.platform),
			config: policy.hash,
		};
		let reuseQueries = false;
		if (options.reuseQueries) {
			try {
				const previous = JSON.parse(await readFile(join(this.#output, "summary.json"), "utf8")) as {
					cacheKey?: string;
				};
				reuseQueries = previous.cacheKey === GraphSnapshot.key(parts);
			} catch {}
		}
		let queries = 0,
			noAnswer = 0;
		const comparison = await EnolaCoverage.open(truth, facts, async (fact) => {
			queries++;
			const stdout = join(answers, `${fact.id}.json`),
				stderr = join(answers, `${fact.id}.err`);
			if (reuseQueries) {
				try {
					const status = JSON.parse(await readFile(join(answers, `${fact.id}.status.json`), "utf8")) as {
						exitCode: number;
					};
					const report = EnolaImpact.parse(await readFile(stdout, "utf8"), status.exitCode);
					if (!report.matchesTarget(fact.name)) throw new Error("Enola resolved another target");
					return report;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						noAnswer++;
						return undefined;
					}
				}
			}
			const result = await execute(
				`ulimit -f 16384; ${command(impactArgs(fact.name, fact.file!))} > ${quote(stdout)} 2> ${quote(stderr)}`,
			);
			await writeFile(join(answers, `${fact.id}.status.json`), JSON.stringify({ exitCode: result.code }));
			const text = await readFile(stdout, "utf8");
			try {
				const report = EnolaImpact.parse(text, result.code);
				if (!report.matchesTarget(fact.name)) throw new Error("Enola resolved a different target");
				return report;
			} catch {
				noAnswer++;
				return undefined;
			}
		});
		const measured = comparison.measure(treeHash, version),
			raw = comparison.measure(treeHash, version, "facts");
		await writeFile(join(this.#output, "graph-coverage.json"), JSON.stringify(measured.toJSON()));
		await writeFile(join(this.#output, "facts-coverage.json"), JSON.stringify(raw.toJSON()));
		const cache = await GraphCache.open(join(this.#output, "cache"));
		const graph = GraphSnapshot.create(
			{
				tree: treeHash,
				version,
				binary: await this.#tools.cache.digest(this.#tools.tool("enola"), this.#tools.platform),
				config: policy.hash,
			},
			files,
		);
		await rm(join(cache.root, "graphs", graph.key), { recursive: true, force: true });
		let start = performance.now();
		await cache.store(graph);
		const cacheWriteSeconds = (performance.now() - start) / 1000;
		start = performance.now();
		await cache.read(graph.toJSON().parts);
		const cacheReadSeconds = (performance.now() - start) / 1000;
		let cacheBytes = 0;
		for (const name of await readdir(join(cache.root, "graphs", graph.key)))
			cacheBytes += (await stat(join(cache.root, "graphs", graph.key, name))).size;
		const summary = {
			commit,
			tree: treeHash,
			version,
			files: truth.files.length,
			totals: measured.toJSON().totals,
			factsTotals: raw.toJSON().totals,
			impactTotals: comparison.measure(treeHash, version, "impact").toJSON().totals,
			causes: measured.toJSON().causes,
			queries,
			noAnswer,
			factsStable,
			timings,
			cacheBytes,
			cacheWriteSeconds,
			cacheReadSeconds,
			coverageId: measured.id,
			cacheKey: graph.key,
		};
		await writeFile(join(this.#output, "summary.json"), JSON.stringify(summary, null, 2));
		await writeFile(join(this.#output, "table.md"), measured.render());
		console.log(JSON.stringify(summary));
	}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [tree, output] = process.argv.slice(2);
	if (!tree || !output) throw new Error("Usage: enola-spike.ts <disposable-tree> <output>");
	await (await EnolaSpike.open(tree, output)).run();
}
