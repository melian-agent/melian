/** The start of the caveat a review states once when no lens saw who calls the changed code. */
export const blindCallers =
	"callers were unavailable for every changed site, so no lens saw who calls the changed code";

/** The note, and the caveat, of a review in which triage chose quick for every lens. */
export const lightTriage =
	"triage chose quick for every lens, so the whole review looked lightly, at a change that can steer triage";

const unavailable = "Callers unavailable: ";

/**
 * The caveats a record written before caveats existed holds only as notes. No structured field said so then, so an
 * upgrade reads the two notes Melian itself wrote for them: a caller context absent for the whole review, and triage
 * choosing quick everywhere. A note about one file's callers starts "Callers unavailable for" and is no caveat.
 */
export function legacyCaveats(notes: readonly string[]): string[] {
	return [
		...new Set(
			notes.flatMap((note) =>
				note.startsWith(unavailable)
					? [`${blindCallers}: ${note.slice(unavailable.length)}`]
					: note === lightTriage
						? [lightTriage]
						: [],
			),
		),
	];
}

/** A check record from before caveats, with the caveats its notes stand for; its joined reason splits on "; ". */
export function withLegacyCaveats<T extends { name: string; reason?: string; caveats?: string[] }>(check: T): T {
	if (check.caveats !== undefined || check.reason === undefined || !check.name.startsWith("lens.")) return check;
	const caveats = legacyCaveats(check.reason.split("; "));
	return caveats.length === 0 ? check : { ...check, caveats };
}

/** Callers stored before caveats, with the caveat their notes name when no lens had a caller context. */
export function callersWithLegacyCaveat<
	T extends { readonly notes: Record<string, string[]>; readonly caveat?: string },
>(callers: T): T {
	if (callers.caveat !== undefined) return callers;
	const caveat = legacyCaveats(Object.values(callers.notes).flat()).find((each) => each.startsWith(blindCallers));
	return caveat === undefined ? callers : { ...callers, caveat };
}
