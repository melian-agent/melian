import { RecordError } from "./errors.ts";
import type { Finding } from "./findings.ts";
import { canonicalJson } from "./record.ts";

function bytes(value: unknown): number {
	return Buffer.byteLength(canonicalJson(value));
}

const tooLarge =
	"The change has too many findings from one check to record within the store's 4 MiB limit, even with their detail left out.";

function note(files: number): string {
	const [file, those] = files === 1 ? ["file", "that file"] : ["files", "those files"];
	return `Melian left out the detail for ${files} more ${file} to keep this record under its limit; \`git diff\` shows ${those}.`;
}

/** The bytes one record's sightings may take, and how a check's findings are cut to fit them. */
export class SightingBudget {
	/** The most bytes the canonical JSON of the sightings, as one array, may take. */
	readonly bytes: number;

	constructor(budget: number) {
		this.bytes = budget;
	}

	/**
	 * `findings`, in their order, cut to fit the budget. Under it nothing changes. Past it, in ID order, the findings before
	 * the latest cut that fits keep their detail, and every later one is {@link Finding.abridged} with one note that
	 * counts their files. A finding that abridging under that note would not make smaller keeps its detail wherever it
	 * falls, so no finding grows. Shorter notes are tried first. The same findings always give the same result, and no ID,
	 * severity or resolution changes. Findings whose canonical JSON core cannot write are returned unchanged, and the
	 * store refuses their record as it always has.
	 *
	 * @throws {RecordError} `recordTooLarge` when even every finding abridged passes the budget, so the check fails
	 * closed.
	 */
	fit(findings: readonly Finding[]): Finding[] {
		const ordered = [...findings].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		let full: number[];
		let bare: number[];
		try {
			full = ordered.map((finding) => bytes(finding.toJSON()));
			bare = ordered.map((finding) => bytes(finding.abridged(note(1)).toJSON()) - note(1).length);
		} catch (error) {
			if (error instanceof RecordError) return [...findings];
			throw error;
		}
		const count = ordered.length;
		const kept = [0];
		for (const size of full) kept.push(kept.at(-1)! + size);
		if (2 + Math.max(count - 1, 0) + kept[count]! <= this.bytes) return [...findings];
		// A note's length grows with the files it names, so these are its lengths, shortest first.
		const files = new Set(ordered.map((finding) => finding.properties.path)).size;
		const lengths = new Set(Array.from({ length: files }, (_, index) => note(index + 1).length));
		for (const length of lengths) {
			const shortened = this.#cut(ordered, full, bare, kept, length);
			if (shortened !== undefined) return findings.map((finding) => shortened.get(finding) ?? finding);
		}
		// The message names no finding's text, since a failed check's error reaches the shared record.
		throw new RecordError("recordTooLarge", tooLarge);
	}

	// The abridged findings of a cut that fits when the findings that shrink under a note of `length` are abridged, or
	// undefined when none does. A cut whose own note is longer is passed over, since it could make a finding grow.
	#cut(
		ordered: readonly Finding[],
		full: readonly number[],
		bare: readonly number[],
		kept: readonly number[],
		length: number,
	): Map<Finding, Finding> | undefined {
		const count = ordered.length;
		const shrinks = ordered.map((_, index) => bare[index]! + length < full[index]!);
		// From each index on: how many files the findings that shrink name, the N of the note, how many shrink, and the
		// bytes of all of them without the note.
		const files: number[] = new Array(count + 1).fill(0);
		const shrinking: number[] = new Array(count + 1).fill(0);
		const abridged: number[] = new Array(count + 1).fill(0);
		const seen = new Set<string>();
		for (let index = count - 1; index >= 0; index--) {
			if (shrinks[index]) seen.add(ordered[index]!.properties.path);
			files[index] = seen.size;
			shrinking[index] = shrinking[index + 1]! + (shrinks[index] ? 1 : 0);
			abridged[index] = abridged[index + 1]! + (shrinks[index] ? bare[index]! : full[index]!);
		}
		// The bytes of the array when the findings before `cut` keep their detail and the rest that shrink are abridged.
		const total = (cut: number) =>
			2 + Math.max(count - 1, 0) + kept[cut]! + abridged[cut]! + shrinking[cut]! * note(files[cut]!).length;
		// The latest cut that fits under a note no longer than `length`, so the most findings keep their detail.
		for (let cut = count - 1; cut >= 0; cut--) {
			if (note(files[cut]!).length > length || total(cut) > this.bytes) continue;
			return new Map(
				ordered
					.slice(cut)
					.filter((_, index) => shrinks[cut + index])
					.map((finding) => [finding, finding.abridged(note(files[cut]!))]),
			);
		}
		return undefined;
	}
}
