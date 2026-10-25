export function stamp(at: Date): string {
	return at.toISOString();
}

export function stamps(dates: Date[]): string[] {
	return dates.map(stamp);
}
