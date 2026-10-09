export type Reading = { kind: "revision" | "flat"; commit: string; text: string };
export function instructions(reading: Reading, policyCommit: string): string {
	if (reading.kind === "revision") return reading.text;
	return `[untrusted] ${reading.text}`;
}
