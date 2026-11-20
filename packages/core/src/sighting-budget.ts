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

function note(files: number): string {
	return `Melian left out the detail for ${files} more ${files === 1 ? "file" : "files"} to keep this record under its limit.`;
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
	 * {@link Finding.abridged} with one note that counts their files. The same findings always give the same result, and
	 * no ID, severity or resolution changes. Findings whose canonical JSON core cannot write are returned unchanged, and
	 * the store refuses their record as it always has.
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
		// From each index on: how many files the findings name, the N of the note, and their abridged bytes without it.
		const files: number[] = new Array(count + 1).fill(0);
		const abridged: number[] = new Array(count + 1).fill(0);
		const seen = new Set<string>();
		for (let index = count - 1; index >= 0; index--) {
			seen.add(ordered[index]!.properties.path);
			files[index] = seen.size;
			abridged[index] = abridged[index + 1]! + bare[index]!;
		}
		const kept = [0];
		for (const size of full) kept.push(kept.at(-1)! + size);
		// The bytes of the array when the findings before `cut` keep their detail and the rest are abridged.
		const total = (cut: number) =>
			2 + Math.max(count - 1, 0) + kept[cut]! + abridged[cut]! + (count - cut) * note(files[cut]!).length;
		if (total(count) <= this.bytes) return [...findings];
		let cut = 0;
		while (cut < count && total(cut + 1) <= this.bytes) cut++;
		// When even every finding abridged passes the budget, they stay abridged: issue #605's pending ruling decides the rest.
		const shortened = new Map(ordered.slice(cut).map((finding) => [finding, finding.abridged(note(files[cut]!))]));
		return findings.map((finding) => shortened.get(finding) ?? finding);
	}
}
