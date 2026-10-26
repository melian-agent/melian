export function stamp(at: Date): string {
	return at.toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
}
