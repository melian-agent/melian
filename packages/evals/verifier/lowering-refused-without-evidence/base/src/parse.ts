export function validate(raw: string): boolean {
	return raw.length > 0;
}

export function parseRecord(raw: string): string[] {
	// Split on commas.
	const fields = raw.split(",");
	return fields;
}
