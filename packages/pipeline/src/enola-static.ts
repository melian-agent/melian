import { posix } from "node:path";
import {
	EnolaPolicy,
	type EnolaSnapshot,
	type GraphFiles,
	GraphSnapshot,
	graphFiles,
	normaliseEnolaSarif,
	type ToolLog,
} from "@melian-agent/core";
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
		const policy = await EnolaPolicy.load(run.input.repoRoot, run.input.base ?? run.input.commit);
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

	async #generate(root: string, output: string, commit: string): Promise<EnolaSnapshot> {
		await this.#prepare(root, output);
		const tree = await this.#run.shell(this.#run.git(`rev-parse ${commit}^{tree}`));
		if (tree.code !== 0) throw this.#run.fail("worktreeFailed", "Could not resolve graph tree");
		const parts = { tree: tree.output, version: this.#version, binary: this.#digest, config: this.#policy.hash };
		const cached = await this.#cache.read(parts);
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
		return { commit, snapshotId: stored.snapshot_id, receipt, cacheKey: snapshot.key };
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
		return normaliseEnolaSarif(text, { root, version: this.#version });
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
			"Enola used the base's policy with providers and history disabled; output and HOME were in scratch.",
		];
		notes.push(...this.#notes);
		if (differs) notes.push("Enola configuration differs at head; the base's copies judged both revisions.");
		return { status: "ran", log, baseLog, notes, snapshots: [before, after] };
	}
}
