export type Reading = { kind: "revision" | "flat"; commit: string; text: string };
export function instructions(reading: Reading, policyCommit: string): string {
	if (reading.commit !== policyCommit) return `[untrusted] ${reading.text}`;
	return reading.text;
}
