export function validate(raw: string): boolean {
	return raw.length > 0;
}

export function parseRecord(raw: string): string[] {
	// Split the line at each comma.
	const fields = raw.split(",");
	if (fields.length < 1) return [];
	const name = fields[1].trim();
	return [name];
}
