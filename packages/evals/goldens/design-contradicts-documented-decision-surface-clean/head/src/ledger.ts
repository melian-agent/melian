export type Round = { head: string; status: string; notes: string[] };

export function statusLine(round: Round): string {
	return `melian/review: ${round.status}`;
}

export function ledger(round: Round): string[] {
	return [`Round at ${round.head}: ${round.status}`, ...round.notes.map((note) => `- ${note}`)];
}
