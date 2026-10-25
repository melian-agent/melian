import { carriedCheckPrefix, type FindingSource, type Revision } from "@melian-agent/core";
import { type CarriedMark, FindingsDocument, producerKey, type StoredSighting } from "./findings.ts";
import type { Context, ConversationId, Harness } from "./harness.ts";

/** The producer prefix a carried sighting is stored under, once whatever heads it crosses. */
export const carriedPrefix = carriedCheckPrefix;

/** The source a lens's sighting is carried under: its check with one `carried/` prefix, and its version. */
export function carriedSource(source: FindingSource): FindingSource {
	return {
		...source,
		check: source.check.startsWith(carriedPrefix) ? source.check : `${carriedPrefix}${source.check}`,
	};
}

/** One sighting the carry copied, and whether the move changed the lines it cites. */
export interface CarriedSighting {
	readonly id: string;
	readonly source: FindingSource;
	readonly changed: boolean;
}

/**
 * Copies the lens sightings of an earlier decided round into this head's key, each under its producer with one
 * `carried/` prefix, mapped by git to this head's lines, with cause classified again against the whole diff. A
 * sighting whose lines the move left alone keeps its verifications; one whose lines changed is marked changed, so the
 * verifier judges it again. The carry never lowers, drops or reopens a finding: it writes sightings only, and leaves
 * each lifecycle as it stands. A sighting in a file the move deleted is not carried.
 */
export class SightingCarry {
	readonly harness: Harness;
	readonly root: ConversationId;

	constructor(harness: Harness, root: ConversationId) {
		this.harness = harness;
		this.root = root;
	}

	/**
	 * Carries the sightings at `from`, a revision key of the round `round`, to `to`, the revision key of `revision`,
	 * across `map`, the move from the earlier head to this one. Returns what it carried, and the IDs it could not carry.
	 */
	async carry(
		input: {
			readonly from: string;
			readonly round: string;
			readonly to: string;
			readonly revision: Revision;
			readonly map: Revision;
		},
		context: Context,
	): Promise<{ carried: CarriedSighting[]; lost: string[] }> {
		const { from, round, to, revision, map } = input;
		const state =
			(await this.harness.snapshot(FindingsDocument, this.root, context)) ?? FindingsDocument.definition.initial();
		const carried: { id: string; key: string; sighting: StoredSighting; mark: CarriedMark; copy?: string }[] = [];
		const lost: string[] = [];
		for (const [id, record] of Object.entries(state.items)) {
			for (const [key, sighting] of Object.entries(record.sightings[from] ?? {})) {
				const { source } = sighting.properties;
				const check = source.check.startsWith(carriedPrefix)
					? source.check.slice(carriedPrefix.length)
					: source.check;
				if (!check.startsWith("lens.")) continue;
				const region = sighting.locations[0]!.physicalLocation.region;
				const location = map.moveLines(
					sighting.properties.path,
					region.startLine,
					region.endLine ?? region.startLine,
				);
				if (location === undefined) {
					lost.push(id);
					continue;
				}
				const evidence = (sighting.properties.evidence ?? []).flatMap((each) => {
					if (each.revision === "base") return [each];
					const target = map.moveLines(each.file, each.startLine, each.endLine ?? each.startLine);
					if (target === undefined) return [];
					return [
						{
							...each,
							file: target.path,
							startLine: target.first,
							...(each.endLine === undefined ? {} : { endLine: target.last }),
						},
					];
				});
				const cause = revision.classifyCause(
					{ file: location.path, startLine: location.first, endLine: location.last },
					evidence,
				);
				// The trigger is the head's own hunk now, so a dismissal reopens by what changed at this head, never the last one.
				const trigger = revision.triggerOf(
					{ file: location.path, startLine: location.first, endLine: location.last },
					evidence,
					cause,
				);
				const next = carriedSource(source);
				const physical = sighting.locations[0]!.physicalLocation;
				const copy: StoredSighting = {
					...sighting,
					locations: [
						{
							...sighting.locations[0]!,
							physicalLocation: {
								...physical,
								artifactLocation: { ...physical.artifactLocation, uri: location.path },
								region: {
									...physical.region,
									startLine: location.first,
									...(physical.region.endLine === undefined ? {} : { endLine: location.last }),
								},
							},
						},
						...sighting.locations.slice(1),
					],
					properties: {
						...sighting.properties,
						path: location.path,
						cause,
						source: next,
						...(evidence.length === 0 ? {} : { evidence: evidence as typeof sighting.properties.evidence }),
						...(trigger === undefined ? {} : { trigger }),
					},
				};
				if (trigger === undefined) delete (copy.properties as { trigger?: unknown }).trigger;
				const earlier = record.carried?.[from]?.[key];
				carried.push({
					id,
					key: producerKey(next),
					sighting: copy,
					mark: { from: earlier?.from ?? round, ...(location.changed ? { changed: true as const } : {}) },
					...(location.changed ? {} : { copy: key }),
				});
			}
		}
		const root = await this.harness.root(context);
		await root.commit(async (tx) => {
			const document = await tx.doc(FindingsDocument, this.root);
			if (!document.revisions.includes(to)) document.revisions.push(to);
			for (const each of carried) {
				const record = document.items[each.id];
				if (record === undefined) continue;
				record.sightings = { ...record.sightings, [to]: { ...record.sightings[to], [each.key]: each.sighting } };
				record.carried = { ...record.carried, [to]: { ...record.carried?.[to], [each.key]: each.mark } };
				const verified = each.copy === undefined ? undefined : record.verifications?.[from]?.[each.copy];
				if (verified !== undefined)
					record.verifications = {
						...record.verifications,
						[to]: {
							...record.verifications?.[to],
							[each.key]: JSON.parse(JSON.stringify(verified)) as typeof verified,
						},
					};
			}
			document.versions = { ...document.versions, [to]: (document.versions[to] ?? 0) + 1 };
		}, context);
		return {
			carried: carried.map(({ id, sighting, mark }) => ({
				id,
				source: sighting.properties.source,
				changed: mark.changed === true,
			})),
			lost,
		};
	}

	/** Deletes every carried sighting at `revision`, as a `--cold` round does before it reviews the whole diff. */
	async clear(revision: string, context: Context): Promise<void> {
		const root = await this.harness.root(context);
		await root.commit(async (tx) => {
			const document = await tx.doc(FindingsDocument, this.root);
			let cleared = false;
			for (const record of Object.values(document.items)) {
				const at = record.sightings[revision];
				if (at === undefined) continue;
				for (const key of Object.keys(at)) {
					if (!key.startsWith(carriedPrefix)) continue;
					delete at[key];
					if (record.verifications?.[revision] !== undefined) delete record.verifications[revision]![key];
					if (record.carried?.[revision] !== undefined) delete record.carried[revision]![key];
					cleared = true;
				}
				if (Object.keys(at).length === 0) delete record.sightings[revision];
			}
			if (cleared) document.versions = { ...document.versions, [revision]: (document.versions[revision] ?? 0) + 1 };
		}, context);
	}
}
