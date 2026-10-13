export function validate(raw: string): boolean {
	return raw.length > 0;
}

export function parseRecord(raw: string): string[] {
	// Split on commas.
	const fields = raw.split(",");
	const name = fields[1].trim();
	return [name];
}
