import { createHash } from "node:crypto";
import {
	type ChangedFile,
	CoverageError,
	type CoverageIds,
	type EnolaImpact,
	type GraphKeyParts,
	ReviewCoverage,
	visibleText,
} from "@melian-agent/core";
import { CoverageCache } from "./coverage-cache.ts";
import { EnolaRun } from "./enola-static.ts";
import type { Context, ConversationId, Harness } from "./harness.ts";
import { ReviewTranscript } from "./review-coverage.ts";
import { Run, type StaticRunInput } from "./static.ts";
import { ToolProvisioning } from "./tool-provisioning.ts";
import { quoteUntrusted } from "./untrusted.ts";

/** One changed declaration and the upstream dependents supplied for it. */
export type CallerGroup = {
	file: string;
	symbol: string;
	callers: ReturnType<EnolaImpact["callers"]>;
	truncated: boolean;
};
/** Validated query data and the cache identity used for transcript coverage. */
export type CallerData = {
	groups: CallerGroup[];
	issues: { file: string; reason: string }[];
	notes: string[];
	paths: string[];
	parts?: GraphKeyParts;
};

/** Advisory callers and coverage from a verified graph; absence never prevents a lens running. */
export class CallerContext {
	readonly #data: CallerData;
	readonly #root?: string;
	private constructor(data: CallerData, root?: string) {
		this.#data = structuredClone(data);
		this.#root = root;
	}
	/** Queries only cached snapshots and verified executables, without downloading. */
	static async open(
		input: StaticRunInput,
		files: readonly ChangedFile[],
		context: Context,
		changedPaths: readonly string[] = files.map((file) => file.path),
	): Promise<CallerContext> {
		if (files.length === 0) return CallerContext.unavailable("No changed files selected by lenses");
		try {
			const tools = input.tools ?? (await ToolProvisioning.open(input.repoRoot));
			const readiness = await tools.cache.readiness(tools.tool("enola"), tools.platform);
			if (readiness !== "verified") return CallerContext.unavailable(`Enola executable ${readiness}`);
			const run = new Run({ ...input, tool: "enola", tools }, context);
			const data = await run.inWorktree(async (root, scratch) =>
				(await EnolaRun.open(run, root, scratch, tools)).callers(files, changedPaths),
			);
			return new CallerContext(data, tools.cache.root);
		} catch (error) {
			return CallerContext.unavailable(error instanceof Error ? error.message : String(error));
		}
	}
	/** Accepts results whose facts and impact contracts the runner already validated. */
	static from(data: CallerData): CallerContext {
		return new CallerContext(data);
	}
	/** Records a missing graph or failed tool as advisory context. */
	static unavailable(reason: string): CallerContext {
		return new CallerContext({ groups: [], issues: [], paths: [], notes: [`Callers unavailable: ${reason}`] });
	}
	/** Exposes candidates for a later verifier without wiring one into the review. */
	callers(paths: readonly string[]): CallerGroup[] {
		return structuredClone(this.#data.groups.filter((group) => paths.includes(group.file)));
	}
	/** Keeps omissions on the lens's record, including query failures in its own files. */
	notes(paths: readonly string[]): string[] {
		return [
			...this.#data.notes,
			...this.#data.issues
				.filter((issue) => paths.includes(issue.file))
				.map((issue) => `Callers unavailable for ${visibleText(issue.file)}: ${issue.reason}`),
		];
	}
	/** Quotes every repository name and path inside this review's existing boundary. */
	render(paths: readonly string[], nonce: string): string {
		const sections: string[] = [];
		let sectionBytes = 0;
		let skipped = 0;
		for (const group of this.callers(paths)) {
			const heading = `${visibleText(group.symbol)} in ${visibleText(group.file)}`;
			if (Buffer.byteLength(heading) > 3072) {
				skipped++;
				continue;
			}
			const lines = [heading];
			let kept = 0;
			let lineBytes = Buffer.byteLength(heading);
			for (const caller of group.callers) {
				if (caller.file === undefined || caller.line === undefined) continue;
				const line = `${visibleText(caller.file)}:${caller.line} ${visibleText(caller.name)}`;
				const bytes = Buffer.byteLength(line) + 1;
				if (kept === 40 || lineBytes + bytes > 3968) break;
				lineBytes += bytes;
				lines.push(line);
				kept++;
			}
			lines.push(
				`${group.callers.length - kept} callers cut locally; upstream cap ${group.truncated ? "reached (additional count unknown)" : "not reached"}.`,
			);
			const section = lines.join("\n");
			const bytes = Buffer.byteLength(section) + (sections.length ? 2 : 0);
			if (sectionBytes + bytes > 64 * 1024) {
				skipped++;
				continue;
			}
			sectionBytes += bytes;
			sections.push(section);
		}
		if (sections.length === 0) return skipped ? `${skipped} caller symbol sections omitted at the prompt limit.` : "";
		return [
			"## Candidate callers outside the diff",
			"These are advisory candidates from an incomplete graph. Each line names the calling function's declaration, not its call site. Test callers are absent unless Enola's configuration widens its globs. Each symbol has at most 40 callers and 4 KiB; upstream queries cap all nodes at 50. Confirm a candidate with read_file before citing it as affected evidence. An absent caller proves nothing; search remains unrestricted.",
			quoteUntrusted("callers", sections.join("\n\n"), nonce),
			...(skipped ? [`${skipped} symbol sections omitted at the prompt limit.`] : []),
		].join("\n\n");
	}
	/** Stores delivered transcript coverage and returns its content identities for the check records. */
	async recordCoverage(input: {
		harness: Harness;
		children: Readonly<Record<string, ConversationId>>;
		lenses: readonly { key: string; name: string }[];
		files: readonly ChangedFile[];
		nonce: string;
		context: Context;
	}): Promise<CoverageIds | undefined> {
		const { parts } = this.#data;
		if (!parts || !this.#root) return undefined;
		const paths = [...new Set([...this.#data.paths, ...input.files.map((file) => file.oldPath ?? file.path)])];
		const transcripts = [];
		for (const lens of input.lenses) {
			const child = input.children[lens.key];
			if (child === undefined) throw new CoverageError("Lens conversation unavailable for review coverage");
			const conversation = await input.harness.conversation(child, input.context);
			if (!conversation) throw new CoverageError("Lens conversation unavailable for review coverage");
			transcripts.push(await ReviewTranscript.read(conversation, input.context, lens.name, paths, input.nonce));
		}
		const files: ChangedFile[] = [...input.files];
		const changed = new Set(input.files.flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])]));
		for (const path of paths)
			if (!changed.has(path)) files.push({ path, status: "modified", binary: false, hunks: [] });
		const coverage = ReviewCoverage.compute(
			parts.tree,
			parts.version,
			[...new Set(input.lenses.map((lens) => lens.name))],
			files,
			transcripts.flatMap((transcript) => transcript.reads()),
		);
		const cache = await CoverageCache.open(this.#root);
		const identity = createHash("sha256")
			.update(JSON.stringify({ nonce: input.nonce, children: input.children }))
			.digest("hex");
		const review = await cache.store(parts, coverage, { review: identity });
		const graph = await cache.read(parts, "graph");
		const test = await cache.read(parts, "test");
		return { review, ...(graph ? { graph: graph.id } : {}), ...(test ? { test: test.id } : {}) };
	}
}
