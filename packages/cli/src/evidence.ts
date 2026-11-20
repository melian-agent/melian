import { join } from "node:path";
import { type ExternalFinding, Lens, LensError, loadConfig, userFiles, visibleText } from "@melian-agent/core";
import {
	type CompareHarness,
	type EntryRecord,
	EvidenceError,
	type EvidenceLensFile,
	type EvidenceStage,
	EvidenceStore,
	MissEvidence,
} from "@melian-agent/pipeline";
import { type Io, short } from "./commands.ts";
import { isScripted } from "./models.ts";
import { git, stateDirectory } from "./repository.ts";

type Revision = Parameters<CompareHarness["round"]>[0];

/**
 * The clone's evidence of the misses its comparisons judged valid: the conversations behind each, which hold the head's
 * code and tool output, so nothing but `melian compare evidence` reads them and nothing shares them.
 */
export class CloneEvidence {
	readonly store: EvidenceStore;
	private readonly io: Io;
	private readonly repoRoot: string;

	private constructor(io: Io, repoRoot: string, store: EvidenceStore) {
		this.io = io;
		this.repoRoot = repoRoot;
		this.store = store;
	}

	/** Opens the evidence directory beside the clone's comparison stores, bounded by `evidence.budget`. */
	static async open(io: Io, repoRoot: string): Promise<CloneEvidence> {
		const state = join(await stateDirectory(repoRoot, io.env), ...(isScripted(io.env) ? ["scripted"] : []));
		const { config } = await loadConfig(repoRoot, { kind: "worktree", preferences: userFiles(io.env).config }, ".");
		return new CloneEvidence(io, repoRoot, EvidenceStore.open(state, { budget: config.evidence.budget }));
	}

	/**
	 * Copies the evidence behind `finding`, a valid miss, or says why there is none. Returns 1 when the copy was
	 * refused, after the adjudication it follows was recorded.
	 */
	async keep(harness: CompareHarness, revision: Revision, finding: ExternalFinding): Promise<number> {
		const { id } = finding;
		const owned = await harness.ownedRun(revision);
		if (owned === undefined) {
			this.io.stdout(
				`Kept no evidence for ${id}: this clone holds no record of its round's run. An Actions round's records went with its job, and rerunning ${short(revision.head)} on a host gives a new conversation, not the original.\n`,
			);
			return 0;
		}
		const { storage, ...run } = owned;
		const gathered = await MissEvidence.gather(storage, { ...run, finding });
		try {
			const kept = await this.store.write(gathered.withLensFiles(await this.lensFiles(gathered, finding)));
			this.io.stdout(
				`Kept evidence for ${id}: ${gathered.stages.length} conversations, ${kept.written.length} newly written, at ${visibleText(kept.pointer)}.\n`,
			);
			return 0;
		} catch (error) {
			if (!(error instanceof EvidenceError)) throw error;
			this.io.stderr(
				`melian: the adjudication is recorded, but no evidence was kept: ${visibleText(error.message)}\n`,
			);
			return 1;
		}
	}

	/** Prints the evidence kept for `id` in `round`, every model and tool text made visible. */
	async print(changeset: string, round: string, id: string, json: boolean): Promise<number> {
		const read = await this.store.read(changeset, round, id);
		if (read === undefined) {
			this.io.stderr(
				`melian: Melian kept no evidence for ${id} in round ${round}; melian compare adjudicate keeps it for a valid miss\n`,
			);
			return 1;
		}
		if (json) {
			// JSON escapes control characters; visible text writes the separators and bidi controls it leaves as escapes too.
			this.io.stdout(`${visibleText(JSON.stringify(read))}\n`);
			return 0;
		}
		const { pointer } = read;
		const lines = [
			`Evidence for ${id} in round ${round}: base ${short(pointer.base)}, head ${short(pointer.head)}, policy ${visibleText(pointer.policy)}.`,
			...pointer.lensFiles.map((file) => `Lens ${visibleText(file.lens)}: ${visibleText(file.file)} ${file.blob}`),
			...read.stages.flatMap((stage) => CloneEvidence.stageLines(stage)),
		];
		this.io.stdout(`${lines.join("\n")}\n`);
		return 0;
	}

	private async lensFiles(evidence: MissEvidence, finding: ExternalFinding): Promise<EvidenceLensFile[]> {
		const commit = /^revision:([0-9a-f]{40})$/.exec(evidence.pointer.policy)?.[1];
		const file = finding.site()?.file;
		if (commit === undefined || file === undefined) return [];
		let lenses: Lens[];
		try {
			lenses = await Lens.load(this.repoRoot, { kind: "revision", commit }, [file]);
		} catch (error) {
			if (!(error instanceof LensError)) throw error;
			this.io.stdout(`Warning: could not read the round's lenses: ${visibleText(error.message)}\n`);
			return [];
		}
		const named = new Set(evidence.lenses());
		const files: EvidenceLensFile[] = [];
		for (const lens of lenses) {
			if (!named.has(`${lens.name}@${lens.version}`)) continue;
			// A built-in lens has no file at the commit, and a lens's file name cannot say whether it is one.
			const blob = await git(this.repoRoot, ["rev-parse", "--verify", "--quiet", `${commit}:${lens.file}`]).catch(
				() => undefined,
			);
			if (blob !== undefined) files.push({ lens: `${lens.name}@${lens.version}`, file: lens.file, blob });
		}
		return files;
	}

	private static stageLines({ stage, entries, dropped }: EvidenceStage): string[] {
		return [
			`${visibleText(stage.name)} ${visibleText(stage.subject)}, conversation ${stage.conversation}${dropped === 0 ? "" : `, ${dropped} entries left out after the first`}:`,
			...entries.flatMap((entry) => CloneEvidence.entryLines(entry)),
		];
	}

	private static entryLines(entry: EntryRecord): string[] {
		const messages = (entry.model ?? []) as readonly {
			role?: unknown;
			content?: unknown;
			sections?: Record<string, string | null>;
			toolsAdded?: readonly { name?: unknown }[];
			toolsRemoved?: readonly { name?: unknown }[];
		}[];
		if (messages.length === 0) return CloneEvidence.indented(`${entry.kind}: ${JSON.stringify(entry.data ?? null)}`);
		return messages.flatMap((message) => {
			// A system message's prompt sits in its sections, and a change of prompt or tools often leaves `content` empty.
			const parts =
				typeof message.content === "string"
					? message.content === ""
						? []
						: [{ type: "text", text: message.content }]
					: message.content;
			const tools = (label: string, list: readonly { name?: unknown }[] | undefined) =>
				list === undefined || list.length === 0
					? []
					: CloneEvidence.indented(`${label}: ${list.map((tool) => String(tool.name)).join(", ")}`);
			return [
				`  ${visibleText(String(message.role))}:`,
				...(Array.isArray(parts) ? parts : []).flatMap(
					(part: { type?: unknown; text?: unknown; thinking?: unknown }) =>
						CloneEvidence.indented(
							part.type === "text" && typeof part.text === "string"
								? part.text
								: part.type === "thinking" && typeof part.thinking === "string"
									? `thinking: ${part.thinking}`
									: JSON.stringify(part),
						),
				),
				...Object.entries(message.sections ?? {}).flatMap(([name, text]) =>
					CloneEvidence.indented(text ?? `section ${name} removed`),
				),
				...tools("tools added", message.toolsAdded),
				...tools("tools removed", message.toolsRemoved),
			];
		});
	}

	private static indented(text: string): string[] {
		return text.split(/\r?\n/).map((line) => `    ${visibleText(line)}`);
	}
}
