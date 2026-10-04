export interface Band {
	readonly drop: number;
	readonly accept: number;
}

export class BandError extends Error {}

/** Reads a decision band from configuration: a drop and an accept threshold, each from 0 to 1. */
export function parseBand(value: unknown): Band {
	if (typeof value !== "object" || value === null) throw new BandError("a band is an object");
	const { drop, accept } = value as Record<string, unknown>;
	for (const end of [drop, accept])
		if (typeof end !== "number" || end < 0 || end > 1) throw new BandError("each end of a band is a number from 0 to 1");
	return { drop: drop as number, accept: accept as number };
}
