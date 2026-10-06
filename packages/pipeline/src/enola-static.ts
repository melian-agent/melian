import { posix } from "node:path";
import {
	type ChangedFile,
	EnolaFacts,
	EnolaImpact,
	EnolaPolicy,
	type EnolaSnapshot,
	type GraphFiles,
	GraphSnapshot,
	graphFiles,
	normaliseEnolaSarif,
	TestCoverage,
	type ToolLog,
} from "@melian-agent/core";
import type { CallerData, CallerGroup } from "./callers.ts";
import { CoverageCache } from "./coverage-cache.ts";
import { GraphCache } from "./graph-cache.ts";
import { type Run, type StaticRun, staticOutputLimit } from "./static.ts";
import type { ToolProvisioning } from "./tool-provisioning.ts";

function quote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

export class EnolaRun {
	readonly #run: Run;
	readonly #root: string;
	readonly #scratch: string;
	readonly #binary: string;
	readonly #version: string;
	readonly #policy: EnolaPolicy;
	readonly #cache: GraphCache;
	readonly #digest: string;
	readonly #notes: string[] = [];
	private constructor(
		run: Run,
		root: string,
		scratch: string,
		binary: string,
		version: string,
		policy: EnolaPolicy,
		cache: GraphCache,
		digest: string,
	) {
		this.#run = run;
		this.#root = root;
		this.#scratch = scratch;
		this.#binary = binary;
		this.#version = version;
		this.#policy = policy;
		this.#cache = cache;
		this.#digest = digest;
	}

	static async open(run: Run, root: string, scratch: string, tools: ToolProvisioning): Promise<EnolaRun> {
		const binary = await tools.binary("enola");
		const version = tools.tool("enola").version;
		const policy = await EnolaPolicy.load(
			run.input.repoRoot,
			run.input.policyCommit ?? run.input.base ?? run.input.commit,
		);
		return new EnolaRun(
			run,
			root,
			scratch,
			binary,
			version,
			policy,
			await GraphCache.open(tools.cache.root),
			await tools.cache.digest(tools.tool("enola"), tools.platform),
		);
	}

	async #required(command: string, phase: string): Promise<void> {
		const result = await this.#run.shell(command);
		if (result.code !== 0)
			throw this.#run.fail("toolFailed", `Enola ${phase} exited ${result.code}: ${result.output}`);
	}

	#command(root: string, output: string, args: string): string {
		return `cd ${quote(root)} && ulimit -f ${staticOutputLimit / 1024} && HOME=${quote(posix.join(this.#scratch, "home"))} ENOLA_NO_UPDATE_CHECK=1 ${quote(this.#binary)} ${args} ${quote(posix.join(output, "config.yaml"))}`;
	}

	async #prepare(root: string, output: string): Promise<void> {
		const { env } = this.#run.input;
		const policy = this.#policy.toJSON();
		await this.#required(
			`if [ -L ${quote(posix.join(root, "enola"))} ]; then rm -f ${quote(posix.join(root, "enola"))}; fi; mkdir -p ${quote(output)} ${quote(posix.join(this.#scratch, "home"))}; rm -rf ${quote(posix.join(root, ".enola"))} ${quote(posix.join(root, "enola", "constraints"))}; rm -f ${quote(posix.join(root, "enola.yaml"))} ${quote(posix.join(root, "mcp-arch.yaml"))} ${quote(posix.join(root, "enola-intent.yaml"))}; ln -s ${quote(output)} ${quote(posix.join(root, ".enola"))}`,
			"policy setup",
		);
		for (const file of policy.files) {
			const target = posix.join(root, file.path);
			await this.#required(`mkdir -p ${quote(posix.dirname(target))}`, "policy directory");
			const written = await env.writeFile(target, file.text, this.#run.context);
			if (!written.ok) throw this.#run.fail("toolFailed", `Could not copy Enola policy: ${written.error.message}`);
		}
		const written = await env.writeFile(posix.join(output, "config.yaml"), policy.config, this.#run.context);
		if (!written.ok)
			throw this.#run.fail("toolFailed", `Could not write Enola configuration: ${written.error.message}`);
	}

	async #coverage(snapshot: GraphSnapshot): Promise<{ graph?: string; test: string }> {
		const cache = await CoverageCache.open(this.#cache.root);
		const parts = snapshot.toJSON().parts;
		const graph = await cache.read(parts, "graph");
		const test = await cache.store(parts, TestCoverage.unavailable(parts.tree, parts.version));
		return { ...(graph ? { graph: graph.id } : {}), test };
	}

	async #generate(root: string, output: string, commit: string, cachedOnly = false): Promise<EnolaSnapshot> {
		await this.#prepare(root, output);
		const tree = await this.#run.shell(this.#run.git(`rev-parse ${commit}^{tree}`));
		if (tree.code !== 0) throw this.#run.fail("worktreeFailed", "Could not resolve graph tree");
		const parts = { tree: tree.output, version: this.#version, binary: this.#digest, config: this.#policy.hash };
		const cached = await this.#cache.read(parts);
		if (!cached && cachedOnly)
			throw this.#run.fail("toolMissing", "No verified Enola snapshot for this tree and policy");
		if (cached) {
			for (const [name, text] of Object.entries(cached.files())) {
				const written = await this.#run.input.env.writeFile(posix.join(output, name), text, this.#run.context);
				if (!written.ok) throw this.#run.fail("toolFailed", `Could not restore graph ${name}`);
			}
			this.#notes.push(`Enola graph cache hit: ${cached.key}`);
			return {
				commit,
				snapshotId: cached.snapshotId,
				receipt: cached.files()["receipt.json"],
				cacheKey: cached.key,
				coverage: await this.#coverage(cached),
			};
		}
		const log = posix.join(output, "generate.log");
		const result = await this.#run.shell(`${this.#command(root, output, "--generate")} > ${quote(log)} 2>&1`);
		if (result.code !== 0)
			throw this.#run.fail(
				"toolFailed",
				`Enola generate exited ${result.code}: ${((await this.#run.readOutput(log)) ?? result.output).slice(0, 4096)}`,
			);
		for (const name of ["facts.jsonl", "insights.json", "receipt.json"]) {
			if ((await this.#run.readOutput(posix.join(output, name))) === undefined)
				throw this.#run.fail("invalidOutput", `Enola generated no ${name}`);
		}
		const receipt = (await this.#run.readOutput(posix.join(output, "receipt.json")))!;
		let stored: { format_version?: unknown; snapshot_id?: unknown; enola_version?: unknown };
		try {
			stored = JSON.parse(receipt);
		} catch (cause) {
			throw this.#run.fail("invalidOutput", "Enola receipt is not JSON", cause);
		}
		if (
			stored?.format_version !== 1 ||
			typeof stored.snapshot_id !== "string" ||
			!/^sha256:[a-f0-9]{64}$/.test(stored.snapshot_id) ||
			stored.enola_version !== this.#version
		)
			throw this.#run.fail("invalidOutput", "Enola receipt has an unsupported format, identity, or version");
		const files: Partial<GraphFiles> = {};
		for (const name of graphFiles) {
			const text = await this.#run.readOutput(posix.join(output, name));
			if (text !== undefined) files[name] = text;
		}
		let snapshot: GraphSnapshot;
		try {
			snapshot = GraphSnapshot.create(parts, files as GraphFiles);
		} catch (cause) {
			throw this.#run.fail("invalidOutput", "Enola graph artifacts are invalid", cause);
		}
		await this.#cache.store(snapshot);
		this.#notes.push(`Enola graph cache miss: ${snapshot.key}`);
		return {
			commit,
			snapshotId: stored.snapshot_id,
			receipt,
			cacheKey: snapshot.key,
			coverage: await this.#coverage(snapshot),
		};
	}

	async #sarif(root: string, output: string, baseline: string): Promise<ToolLog> {
		const report = posix.join(output, "check.sarif");
		const error = posix.join(output, "check.err");
		const failOn = this.#policy.toJSON().failOn;
		const args = `check --format=sarif --baseline=${quote(baseline)}${failOn.length ? ` --fail-on=${quote(failOn.join(","))}` : ""}`;
		const result = await this.#run.shell(
			`${this.#command(root, output, args)} > ${quote(report)} 2> ${quote(error)}`,
		);
		if (result.code !== 0 && result.code !== 1)
			throw this.#run.fail(
				"toolFailed",
				`Enola check exited ${result.code}: ${((await this.#run.readOutput(error)) ?? result.output).slice(0, 4096)}`,
			);
		const text = await this.#run.readOutput(report);
		if (text === undefined) throw this.#run.fail("invalidOutput", "Enola check wrote no SARIF");
		const log = normaliseEnolaSarif(text, { root, version: this.#version });
		if (result.code === 1 && log.runs.every((run) => run.results.length === 0))
			this.#notes.push("Enola check exited 1 with no unsuppressed SARIF results; treated as clean.");
		return log;
	}

	async callers(files: readonly ChangedFile[], changedPaths: readonly string[]): Promise<CallerData> {
		const output = posix.join(this.#scratch, "head-output");
		await this.#generate(this.#root, output, this.#run.input.commit, true);
		const text = await this.#run.readOutput(posix.join(output, "facts.jsonl"));
		if (text === undefined) throw this.#run.fail("invalidOutput", "Enola snapshot has no facts");
		const facts = EnolaFacts.parse(text);
		const groups: CallerGroup[] = [];
		const notes: string[] = [];
		const issues: CallerData["issues"] = [];
		const names = new Map<string, number>();
		for (const fact of facts.toJSON())
			if (fact.kind === "symbol") names.set(fact.name, (names.get(fact.name) ?? 0) + 1);
		const deadline = Date.now() + this.#run.input.settings.timeout * 1000;
		let omitted = 0;
		let attempted = 0;
		for (const file of files) {
			const symbols = facts
				.inFile(file.path)
				.filter((fact) => fact.line !== undefined)
				.sort((a, b) => a.line! - b.line!);
			const starts = [...new Set(symbols.map((fact) => fact.line!))];
			const nextLines = new Map(starts.map((line, index) => [line, starts[index + 1] ?? Infinity]));
			const changed = symbols.filter((fact) =>
				file.hunks.some((hunk) => {
					const next = nextLines.get(fact.line!)!;
					return fact.line! < hunk.newStart + Math.max(1, hunk.newLines) && next > hunk.newStart;
				}),
			);
			for (const symbol of changed) {
				if (attempted === 128) {
					omitted++;
					continue;
				}
				attempted++;
				try {
					if (names.get(symbol.name) !== 1) throw new Error("directory-scoped name is ambiguous");
					if (Date.now() >= deadline) throw new Error("caller-query time budget ended");
					const report = posix.join(output, "impact.json");
					const error = posix.join(output, "impact.err");
					const result = await this.#run.shell(
						`${this.#command(this.#root, output, `impact --json --max-depth 1 --max-nodes 50 ${quote(`file:${file.path} ${symbol.name}`)}`)} > ${quote(report)} 2> ${quote(error)}`,
						Math.max(1, Math.ceil((deadline - Date.now()) / 1000)),
					);
					const impact = EnolaImpact.parse((await this.#run.readOutput(report)) ?? "", result.code);
					if (!impact.matchesTarget(symbol.name)) throw new Error("impact selected another full target name");
					groups.push({
						file: file.path,
						symbol: symbol.name,
						callers: impact
							.callers()
							.filter(
								(node) =>
									node.file !== undefined && node.line !== undefined && !changedPaths.includes(node.file),
							),
						truncated: impact.truncated,
					});
				} catch (error) {
					issues.push({
						file: file.path,
						reason: `line ${symbol.line}: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
			}
		}
		if (omitted) notes.push(`${omitted} changed symbols omitted at the caller-query limit of 128.`);
		const tree = await this.#run.shell(this.#run.git(`rev-parse ${this.#run.input.commit}^{tree}`));
		if (tree.code !== 0) throw this.#run.fail("worktreeFailed", "Could not resolve caller graph tree");
		const listing = posix.join(output, "paths");
		const listed = await this.#run.shell(
			`${this.#run.git(`ls-tree -r --name-only -z ${this.#run.input.commit}`)} > ${quote(listing)}`,
		);
		const paths = listed.code === 0 ? await this.#run.readOutput(listing) : undefined;
		if (paths === undefined) throw this.#run.fail("worktreeFailed", "Could not list caller graph files");
		return {
			groups,
			issues,
			notes,
			paths: paths.split("\0").filter(Boolean),
			parts: { tree: tree.output, version: this.#version, binary: this.#digest, config: this.#policy.hash },
		};
	}

	async check(): Promise<StaticRun> {
		const base = this.#run.input.base ?? this.#run.input.commit;
		if (!/^[a-f0-9]{40,64}$/.test(base))
			throw this.#run.fail("worktreeFailed", "Enola base must be a full commit hash");
		const baseRoot = posix.join(this.#scratch, "base", "tree");
		const added = await this.#run.worktreeCommand(
			this.#run.git(
				`worktree add --detach --quiet --lock --reason ${quote(`melian-static pid ${process.pid}`)} ${quote(baseRoot)} ${base}`,
			),
		);
		if (added.code !== 0) throw this.#run.fail("worktreeFailed", `Enola base worktree failed: ${added.output}`);
		const baseOutput = posix.join(this.#scratch, "base-output");
		const headOutput = posix.join(this.#scratch, "head-output");
		const before = await this.#generate(baseRoot, baseOutput, base);
		await this.#required(
			`${this.#command(baseRoot, baseOutput, "baseline pin")} > ${quote(posix.join(baseOutput, "pin.log"))} 2>&1`,
			"baseline pin",
		);
		const baseline = posix.join(baseOutput, "baseline");
		const baseLog = await this.#sarif(baseRoot, baseOutput, baseline);
		const after = await this.#generate(this.#root, headOutput, this.#run.input.commit);
		const log = await this.#sarif(this.#root, headOutput, baseline);
		const differs = await this.#policy.differs(this.#run.input.repoRoot, this.#run.input.commit);
		const notes = [
			this.#run.input.policyCommit === undefined
				? "Enola used the base's policy with providers and history disabled; output and HOME were in scratch."
				: `Enola used policy commit ${this.#run.input.policyCommit} with providers and history disabled; output and HOME were in scratch.`,
		];
		notes.push(...this.#notes);
		if (differs)
			notes.push(
				this.#run.input.policyCommit === undefined
					? "Enola configuration differs at head; the base's copies judged both revisions."
					: "Enola configuration differs at head; the trusted policy commit's copies judged both revisions.",
			);
		return { status: "ran", log, baseLog, notes, snapshots: [before, after] };
	}
}
