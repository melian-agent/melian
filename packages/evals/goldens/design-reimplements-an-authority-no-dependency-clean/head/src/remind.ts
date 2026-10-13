const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

export function seconds(duration: string): number {
	const match = /^(\d+)([smhd])$/.exec(duration);
	if (match === null) throw new Error(`invalid duration: ${duration}`);
	return Number(match[1]) * units[match[2]!]!;
}
