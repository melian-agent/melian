import type { StoredCheckRecord, StoredVerdict } from "@melian-agent/core";
import { expect } from "vitest";
import { blindCallers } from "../../src/caveats.ts";
import { withheld } from "../../src/review-records.ts";

const checks = (verdict: StoredVerdict): StoredCheckRecord[] => [...(verdict.ran ?? []), ...verdict.notRun];
const facts = ({ reason, error, caveats, ...rest }: StoredCheckRecord) => rest;
const shared = (verdict: StoredVerdict) => ({
	...verdict,
	...(verdict.ran === undefined ? {} : { ran: verdict.ran.map(facts) }),
	notRun: verdict.notRun.map(facts),
});

// The host's verdict as a reader of its records decides it: equal in every field, except that a check's reason, error
// or caveat the host kept may read as the sentence a record holds in its place.
export function expectSharedVerdict(reader: StoredVerdict, host: StoredVerdict): void {
	expect(shared(reader)).toEqual(shared(host));
	const own = checks(host);
	checks(reader).forEach((check, index) => {
		const kept = own[index]!;
		for (const field of ["reason", "error"] as const) {
			const same = check[field] === kept[field] || (kept[field] !== undefined && check[field] === withheld);
			expect({ check: check.name, field, same }).toEqual({ check: check.name, field, same: true });
		}
		expect(check.caveats?.length).toBe(kept.caveats?.length);
		for (const [at, caveat] of (check.caveats ?? []).entries()) {
			const same = caveat === kept.caveats![at] || caveat === withheld || caveat === blindCallers;
			expect({ check: check.name, caveat, same }).toEqual({ check: check.name, caveat, same: true });
		}
	});
}
