export type Reading = { kind: "revision" | "flat"; commit: string; text: string };
export function instructions(reading: Reading, policyCommit: string): string {
	const matchesPolicy = reading.commit === policyCommit;
	return matchesPolicy ? reading.text : `[untrusted] ${reading.text}`;
}
