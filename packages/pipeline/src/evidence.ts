import { randomUUID } from "node:crypto";
import { type FileHandle, lstat, mkdir, open, readdir, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	type ExternalFinding,
	type ExternalSite,
	type Finding,
	isChangesetId,
	lensCovers,
	type Verdict,
} from "@melian-agent/core";
import {
	AssistantEntry,
	backgroundContext,
	type Context,
	type ConversationId,
	type EntryRecord,
	type Storage,
} from "./harness.ts";
import type { Round } from "./rounds.ts";
import { type Stage, TelemetryReader } from "./telemetry.ts";

/** What one stage file holds at most before compression, and the default size of the whole evidence directory. */
export const evidenceLimits = { stage: 16 * 1024 ** 2, budget: 1024 ** 3 } as const;

const localRound = /^(?:r[1-9][0-9]*|k[0-9a-f]{16})$/;
const stageId = /^conversation:([1-9][0-9]*)$/;
const externalId = /^[0-9a-f]{16}$/;

/** A lens file the round's policy commit held, by its blob ID, never its text. */
export type EvidenceLensFile = { lens: string; file: string; blob: string };

/** One stage and its conversation's stored entries, oldest first. */
export type EvidenceConversation = { stage: Stage; entries: EntryRecord[] };

/**
 * A stage file: every entry of its conversation, or its leading entries, the prompt and the instructions before the
 * first reply, and as many of the last as fit {@link evidenceLimits}, with the count left out.
 */
export type EvidenceStage = EvidenceConversation & { version: 1; dropped: number };

/** What a miss points at: its round's commits, the lens files' blob IDs, and the stages that could have found it. */
export type EvidencePointer = {
	version: 1;
	changeset: string;
	round: string;
	external: string;
	base: string;
	head: string;
	policy: string;
	lensFiles: EvidenceLensFile[];
	stages: string[];
};

/** Thrown when evidence cannot be written or read: a name that is not safe, a link in its path, or the budget. */
export class EvidenceError extends Error {
	readonly code: "unsafeName" | "link" | "budget" | "unreadable";

	constructor(code: EvidenceError["code"], message: string) {
		super(message);
		this.name = "EvidenceError";
		this.code = code;
	}
}

/**
 * The material behind one miss of a round: the conversations of the lens runs whose coverage held its file, and of
 * the verifiers that judged a lens sighting at its file on lines overlapping its own, with their telemetry stages.
 */
export class MissEvidence {
	readonly pointer: EvidencePointer;
	readonly stages: readonly EvidenceConversation[];

	private constructor(pointer: EvidencePointer, stages: readonly EvidenceConversation[]) {
		this.pointer = pointer;
		this.stages = stages;
	}

	/** Evidence from a pointer and the conversations it names, in its order. */
	static from(pointer: EvidencePointer, stages: readonly EvidenceConversation[]): MissEvidence {
		return new MissEvidence({ ...pointer, stages: stages.map(({ stage }) => stage.id) }, stages);
	}

	/**
	 * Gathers the evidence for `finding`, a miss of `round`, whose run this storage holds: the conversations of the stages
	 * {@link MissEvidence.stagesAt} chooses from the round's telemetry, in its order.
	 */
	static async gather(
		storage: Storage,
		options: { readonly round: Round; readonly verdict: Verdict; readonly finding: ExternalFinding },
		context: Context = backgroundContext,
	): Promise<MissEvidence> {
		const { round, verdict, finding } = options;
		const telemetry = await TelemetryReader.open(storage).read(round.revisionKey(), undefined, context);
		const stages: EvidenceConversation[] = [];
		for (const stage of MissEvidence.stagesAt(telemetry.stages, verdict.all(), finding.site()))
			stages.push(await MissEvidence.conversation(storage, stage, context));
		const { base, head } = round.stored;
		return MissEvidence.from(
			{
				version: 1,
				changeset: round.id.slice(0, round.id.indexOf(".")),
				round: round.id,
				external: finding.id,
				base,
				head,
				policy: round.stored.provenance?.policy ?? "config",
				lensFiles: [],
				stages: [],
			},
			stages,
		);
	}

	/**
	 * The stages behind a miss at `site`: each lens run whose coverage held its file, and each candidate verifier that
	 * judged a lens finding of `findings` at that file on lines overlapping the site, or a claim reported with one. A miss with no site has none.
	 */
	static stagesAt(telemetry: readonly Stage[], findings: readonly Finding[], site: ExternalSite | undefined): Stage[] {
		if (site === undefined) return [];
		const sighted = new Set<string>();
		for (const finding of findings) {
			const [start, end] = finding.lines();
			if (
				finding.properties.path !== site.file ||
				!finding.properties.source.check.startsWith("lens.") ||
				start > site.end ||
				end < site.start
			)
				continue;
			sighted.add(finding.properties.id);
			for (const other of finding.properties.alsoReportedAs ?? [])
				if (other.check.startsWith("lens.")) sighted.add(other.id);
			for (const claim of finding.properties.otherClaims ?? []) sighted.add(claim.id);
		}
		return telemetry.filter(
			(stage) =>
				stage.conversation !== undefined &&
				((stage.name === "melian.lens" && stage.coverage !== undefined && lensCovers(stage.coverage, site.file)) ||
					(stage.name === "melian.verification.candidate" &&
						stage.subject.split(",").some((id) => sighted.has(id)))),
		);
	}

	/** Every entry of `stage`'s conversation, oldest first, read page by page. */
	static async conversation(
		storage: Storage,
		stage: Stage,
		context: Context = backgroundContext,
	): Promise<EvidenceConversation> {
		const conversationId = stage.conversation as ConversationId;
		const entries: EntryRecord[] = [];
		let page = await storage.scanEntries({ conversationId, order: "ascending" }, 200, undefined, context);
		for (;;) {
			entries.push(...page.items);
			if (page.next === undefined) break;
			page = await storage.scanEntries({ conversationId, order: "ascending" }, 200, page.next, context);
		}
		return { stage, entries: JSON.parse(JSON.stringify(entries)) as EntryRecord[] };
	}

	/** The same evidence, naming the lens files its policy commit held. */
	withLensFiles(files: readonly EvidenceLensFile[]): MissEvidence {
		return new MissEvidence({ ...this.pointer, lensFiles: files.map((file) => ({ ...file })) }, this.stages);
	}

	/** The `name@version` of each lens whose run is in the evidence. */
	lenses(): string[] {
		return [
			...new Set(
				this.stages
					.filter(({ stage }) => stage.name === "melian.lens")
					.map(({ stage }) => stage.subject.split("@").slice(0, 2).join("@")),
			),
		];
	}
}

type Planned = { readonly components: readonly string[]; readonly bytes: Buffer };

/**
 * The clone's evidence directory, `evidence/` under the state directory: a stage file per conversation, written once
 * however many misses name it, and a pointer per miss. Every file is mode 0600 and every directory 0700, each file is
 * renamed into place from a temporary name beside it, and no path through a symbolic link is read or written.
 */
export class EvidenceStore {
	readonly directory: string;
	readonly budget: number;
	private readonly state: string;

	private constructor(state: string, budget: number) {
		this.state = state;
		this.directory = join(state, "evidence");
		this.budget = budget;
	}

	/** Opens the evidence directory under `state`, which need not exist yet. Holds nothing to close. */
	static open(state: string, options: { readonly budget?: number } = {}): EvidenceStore {
		return new EvidenceStore(state, options.budget ?? evidenceLimits.budget);
	}

	/** The bytes the evidence directory's files hold, counting no link's target, or 0 when it does not exist. */
	async size(): Promise<number> {
		return EvidenceStore.bytes(this.directory);
	}

	/**
	 * Writes `evidence`: each stage file the directory lacks, then the miss's pointer. Throws {@link EvidenceError}
	 * `budget`, writing nothing, when the directory would pass its budget, and leaves no file behind on any failure.
	 */
	async write(evidence: MissEvidence): Promise<{ readonly pointer: string; readonly written: readonly string[] }> {
		const { pointer } = evidence;
		const round = EvidenceStore.roundPath(pointer.changeset, pointer.round);
		const misses = [...round, "misses"];
		const stages = [...round, "stages"];
		const pointerName = `${EvidenceStore.external(pointer.external)}.json`;
		const planned: Planned[] = [];
		for (const stage of evidence.stages) {
			const path = [...stages, EvidenceStore.stageFile(stage.stage.id)];
			if ((await this.existing(path)) !== undefined) continue;
			planned.push({ components: path, bytes: gzipSync(JSON.stringify(EvidenceStore.bounded(stage))) });
		}
		const pointerBytes = Buffer.from(`${JSON.stringify(pointer)}\n`);
		const replaced = (await this.existing([...misses, pointerName]))?.size ?? 0;
		const adding = planned.reduce((sum, each) => sum + each.bytes.length, pointerBytes.length) - replaced;
		const held = await this.size();
		if (held + adding > this.budget)
			throw new EvidenceError(
				"budget",
				`${join(this.directory, pointer.changeset)}/ would take the evidence directory past its budget: it holds ${held} bytes, this evidence needs ${adding} more, and evidence.budget is ${this.budget}. melian store prune keeps evidence. Raise evidence.budget in your configuration until the prune lands in issue #627 (https://github.com/melian-agent/melian/issues/627). This refusal wrote no file and lost no evidence already kept`,
			);
		planned.push({ components: [...misses, pointerName], bytes: pointerBytes });
		const created: string[] = [];
		const directories: string[] = [];
		try {
			for (const each of planned) {
				await this.directoryFor(each.components.slice(0, -1), directories);
				await this.place(each);
				created.push(join(this.directory, ...each.components));
			}
		} catch (error) {
			for (const path of created.reverse()) await unlink(path).catch(() => undefined);
			for (const directory of directories.reverse()) await rmdir(directory).catch(() => undefined);
			throw error;
		}
		return { pointer: join(this.directory, ...misses, pointerName), written: created.slice(0, -1) };
	}

	/** The evidence written for `external` in `round` of `changeset`, or nothing when none was. */
	async read(
		changeset: string,
		round: string,
		external: string,
	): Promise<{ readonly pointer: EvidencePointer; readonly stages: readonly EvidenceStage[] } | undefined> {
		const base = EvidenceStore.roundPath(changeset, round);
		const pointerPath = [...base, "misses", `${EvidenceStore.external(external)}.json`];
		if ((await this.existing(pointerPath)) === undefined) return undefined;
		const pointer = JSON.parse(await readFile(join(this.directory, ...pointerPath), "utf8")) as EvidencePointer;
		if (pointer.version !== 1 || pointer.round !== round || pointer.external !== external)
			throw new EvidenceError("unreadable", `${join(this.directory, ...pointerPath)} is not this miss's evidence`);
		const stages: EvidenceStage[] = [];
		for (const id of pointer.stages) {
			const path = [...base, "stages", EvidenceStore.stageFile(id)];
			if ((await this.existing(path)) === undefined)
				throw new EvidenceError("unreadable", `${join(this.directory, ...path)} is missing`);
			stages.push(
				JSON.parse(gunzipSync(await readFile(join(this.directory, ...path))).toString("utf8")) as EvidenceStage,
			);
		}
		return { pointer, stages };
	}

	// Keeps the leading entries, the prompt and the instructions before the first reply, then as many of the last as fit
	// the stage limit, counting what it leaves out. Leading entries that alone pass the limit keep as many from the first
	// as fit.
	private static bounded({ stage, entries }: EvidenceConversation): EvidenceStage {
		const sizes = entries.map((entry) => Buffer.byteLength(JSON.stringify(entry)));
		const found = entries.findIndex((entry) => AssistantEntry.is(entry));
		const leading = found === -1 ? entries.length : found;
		// The file's bytes when it keeps the first `head` entries and the last `tail`, at least one, each after the first
		// behind a comma. Each loop below asks only while its count is above 0.
		const bytes = (head: number, tail: number) => {
			const kept = [...sizes.slice(0, head), ...sizes.slice(entries.length - tail)];
			return (
				Buffer.byteLength(
					JSON.stringify({ version: 1, stage, entries: [], dropped: entries.length - kept.length }),
				) + kept.reduce((sum, size) => sum + size + 1, -1)
			);
		};
		let head = leading;
		while (head > 0 && bytes(head, 0) > evidenceLimits.stage) head--;
		let tail = entries.length - leading;
		while (tail > 0 && bytes(head, tail) > evidenceLimits.stage) tail--;
		return {
			version: 1,
			stage,
			entries: [...entries.slice(0, head), ...entries.slice(entries.length - tail)],
			dropped: entries.length - head - tail,
		};
	}

	private static roundPath(changeset: string, round: string): string[] {
		if (!isChangesetId(changeset)) throw new EvidenceError("unsafeName", `${changeset} is not a changeset ID`);
		const local = round.startsWith(`${changeset}.`) ? round.slice(changeset.length + 1) : "";
		if (!localRound.test(local)) throw new EvidenceError("unsafeName", `${round} is not a round of ${changeset}`);
		return [changeset, local];
	}

	private static stageFile(id: string): string {
		const match = stageId.exec(id);
		if (match === null) throw new EvidenceError("unsafeName", `${id} is not a conversation stage`);
		return `conversation-${match[1]}.json.gz`;
	}

	private static external(id: string): string {
		if (!externalId.test(id)) throw new EvidenceError("unsafeName", `${id} is not an external finding ID`);
		return id;
	}

	// Every component below the state directory, the file's own included, read without following a link.
	private async existing(components: readonly string[]): Promise<{ readonly size: number } | undefined> {
		let path = this.state;
		for (const [index, name] of ["evidence", ...components].entries()) {
			path = join(path, name);
			const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined;
				throw error;
			});
			if (stat === undefined) return undefined;
			if (stat.isSymbolicLink())
				throw new EvidenceError("link", `${path} is a symbolic link, which Melian's evidence never follows`);
			if (index === components.length) return stat.isFile() ? { size: stat.size } : undefined;
		}
		return undefined;
	}

	private async directoryFor(components: readonly string[], created: string[]): Promise<void> {
		let path = this.state;
		for (const name of ["evidence", ...components]) {
			path = join(path, name);
			const made = await mkdir(path, { mode: 0o700 }).then(
				() => true,
				(error: NodeJS.ErrnoException) => {
					if (error.code === "EEXIST") return false;
					throw error;
				},
			);
			const stat = await lstat(path);
			if (stat.isSymbolicLink())
				throw new EvidenceError("link", `${path} is a symbolic link, which Melian's evidence never follows`);
			if (!stat.isDirectory()) throw new EvidenceError("unreadable", `${path} is not a directory`);
			if (made) created.push(path);
		}
	}

	private async place(planned: Planned): Promise<void> {
		const final = join(this.directory, ...planned.components);
		const temporary = `${final}.${process.pid}.${randomUUID()}.tmp`;
		let handle: FileHandle | undefined;
		try {
			handle = await open(temporary, "wx", 0o600);
			await handle.chmod(0o600);
			await handle.writeFile(planned.bytes);
			await handle.sync();
			await handle.close();
			handle = undefined;
			const target = await lstat(final).catch(() => undefined);
			if (target?.isSymbolicLink() === true)
				throw new EvidenceError("link", `${final} is a symbolic link, which Melian's evidence never follows`);
			await rename(temporary, final);
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
	}

	private static async bytes(path: string): Promise<number> {
		const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (stat === undefined || stat.isSymbolicLink()) return 0;
		if (!stat.isDirectory()) return stat.size;
		let total = 0;
		for (const name of await readdir(path)) total += await EvidenceStore.bytes(join(path, name));
		return total;
	}
}
