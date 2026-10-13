export function validate(raw: string): boolean {
	return raw.length > 0;
}

export function parseRecord(raw: string): string[] {
	// Split on commas.
	const fields = raw.split(",");
	if (fields.length < 1) return [];
	const name = fields[2].trim();
	return [name];
}
