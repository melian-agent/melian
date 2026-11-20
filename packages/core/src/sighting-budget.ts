import { RecordError } from "./errors.ts";
import type { Finding } from "./findings.ts";
import { canonicalJson, recordLimit } from "./record.ts";

/**
 * What a check record may hold beside its sightings: the envelope, the changeset, revision and key, and the check's
 * result. A test builds a real check record and holds its overhead under this.
 */
export const envelopeAllowance = 4096;

function bytes(value: unknown): number {
	return Buffer.byteLength(canonicalJson(value));
}

const tooLarge =
	"The change has too many guardrails findings to record within the store's 4 MiB limit, even with their detail left out.";

function note(files: number): string {
	const [file, those] = files === 1 ? ["file", "that file"] : ["files", "those files"];
	return `Melian left out the detail for ${files} more ${file} to keep this record under its limit; \`git diff\` shows ${those}.`;
}

/** The bytes one record's sightings may take, and how a check's findings are cut to fit them. */
export class SightingBudget {
	/** A check record's budget: the store's record limit less {@link envelopeAllowance}. */
	static readonly checkRecord = new SightingBudget(recordLimit - envelopeAllowance);

	/** The most bytes the canonical JSON of the sightings, as one array, may take. */
	readonly bytes: number;

	constructor(budget: number) {
		this.bytes = budget;
	}

	/**
	 * `findings`, in their order, cut to fit the budget. Under it nothing changes. Past it, in ID order, a finding keeps
	 * its detail while the full findings so far and every later one abridged fit; every later one is
	 * {@link Finding.abridged} with one note that counts their files. A finding that abridging would not make smaller
	 * keeps its detail wherever it falls, so no finding grows. The same findings always give the same result, and no ID,
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
		// No note is longer than the one naming every file, so a finding smaller under it is smaller under any.
		const longest = note(new Set(ordered.map((finding) => finding.properties.path)).size).length;
		const shrinks = ordered.map((_, index) => bare[index]! + longest < full[index]!);
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
		const kept = [0];
		for (const size of full) kept.push(kept.at(-1)! + size);
		// The bytes of the array when the findings before `cut` keep their detail and the rest that shrink are abridged.
		const total = (cut: number) =>
			2 + Math.max(count - 1, 0) + kept[cut]! + abridged[cut]! + shrinking[cut]! * note(files[cut]!).length;
		if (total(count) <= this.bytes) return [...findings];
		// The message names no finding's text, since a failed check's error reaches the shared record.
		if (total(0) > this.bytes) throw new RecordError("recordTooLarge", tooLarge);
		let cut = 0;
		while (cut < count && total(cut + 1) <= this.bytes) cut++;
		const shortened = new Map(
			ordered
				.slice(cut)
				.filter((_, index) => shrinks[cut + index])
				.map((finding) => [finding, finding.abridged(note(files[cut]!))]),
		);
		return findings.map((finding) => shortened.get(finding) ?? finding);
	}
}
