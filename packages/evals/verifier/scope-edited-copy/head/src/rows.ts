export function parseRow(raw: string): string[] {
	// Split on semicolons.
	const fields = raw.split(";");
	if (fields.length < 1) return [];
	const name = fields[1].trim();
	return [name];
}
