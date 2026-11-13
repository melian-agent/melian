// Issue #379: the gate of the shared record decision's section 9 and the import of its section 8, as the decision words
// them, in the smallest form that runs. Where the decision says nothing, the rule this script follows is marked
// "READING", and the report names it, since each is a place the decision can be read two ways.

import { execFileSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import type { StoredVerdict } from "@melian-agent/core";
import { parse } from "yaml";
import { canonical, type RecordEnvelope, recordId } from "../record-373/record.ts";
import { computeVerdict } from "./verdict.ts";

// The decision's envelope adds `supersedes`, and makes the signature optional.
export type Envelope = RecordEnvelope & { supersedes?: string[] };

export interface RecordStore {
	list(changeset: string): Promise<Envelope[]>;
}

export type Policy = { writers: boolean; host?: { id: string; key: string } };

// Section 6: a repository with `trust.writers: false` pins the trusted host's public half in the root melian.yaml, read
// from the base commit. READING: the decision names no field, so this reads `trust.host: { id, key }`, the key in raw
// base64url as issue #371 used.
export function policyAt(repo: string, base: string): Policy {
	const text = execFileSync("git", ["-C", repo, "show", `${base}:melian.yaml`], { encoding: "utf8", stdio: "pipe" });
	const trust = (parse(text) as { trust?: { writers?: boolean; host?: { id: string; key: string } } } | null)?.trust;
	return { writers: trust?.writers !== false, ...(trust?.host === undefined ? {} : { host: trust.host }) };
}

function signedBy(record: Envelope, host: { id: string; key: string }): boolean {
	if (record.signer !== host.id || typeof record.signature !== "string") return false;
	const { signature, ...unsigned } = record;
	const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: host.key }, format: "jwk" });
	try {
		return verify(null, Buffer.from(canonical(unsigned), "utf8"), key, Buffer.from(signature, "base64"));
	} catch {
		return false;
	}
}

/**
 * Which records count. Section 6: a record in the store counts, except under `trust.writers: false`, where only the
 * pinned host key's do. Section 8: a record from a fork's head counts only from the trusted host. READING: a repository
 * that pins no key has no way to tell the trusted host's record from a writer's, so under a fork's head nothing counts.
 */
export function trusted(policy: Policy, fork: boolean): (record: Envelope) => boolean {
	if (!policy.writers || fork) return (record) => policy.host !== undefined && signedBy(record, policy.host);
	return () => true;
}

// Section 4: a record that another record, itself counted, names in `supersedes` no longer counts.
export function standing(records: readonly Envelope[]): Envelope[] {
	const superseded = new Set(records.flatMap((record) => record.supersedes ?? []));
	return records.filter((record) => !superseded.has(recordId(record)));
}

export type Gate = { exit: 0 | 1; reason: string; verdict?: StoredVerdict };

const failing = (verdict: StoredVerdict) => verdict.status === "not-reviewed" || verdict.blocking;

/** `melian gate "#N"` of section 9, given the store, the base commit's policy and the pull request's base and head. */
export async function gate(input: {
	store: RecordStore;
	changeset: string;
	revision: string;
	repo: string;
	base: string;
	fork?: boolean;
	reopen?: boolean;
}): Promise<Gate> {
	let listed: Envelope[];
	try {
		listed = await input.store.list(input.changeset);
	} catch (error) {
		return { exit: 1, reason: `the store cannot be listed: ${(error as Error).message}` };
	}
	let policy: Policy;
	try {
		policy = policyAt(input.repo, input.base);
	} catch {
		// READING: the decision does not say what the gate does when the base's melian.yaml cannot be read.
		return { exit: 1, reason: "the base commit's melian.yaml cannot be read" };
	}
	const accept = trusted(policy, input.fork === true);
	const counted = standing(listed.filter(accept));
	const rounds = counted.filter((record) => record.kind === "round" && record.key === input.revision);
	if (rounds.length === 0) return { exit: 1, reason: "no round for the revision" };
	// Section 4: when two rounds of one revision both stand, the gate takes the worse verdict.
	const verdicts: StoredVerdict[] = [];
	for (const round of rounds) {
		const others = new Set(rounds.filter((each) => each !== round).map(recordId));
		const computed = await computeVerdict(
			counted.filter((record) => !others.has(recordId(record))),
			() => true,
			input.revision,
			input.repo,
			{ reopen: input.reopen ?? true },
		);
		if (computed !== undefined) verdicts.push(computed.verdict);
	}
	const worst = verdicts.find(failing) ?? verdicts[0];
	if (worst === undefined) return { exit: 1, reason: "no round could be computed" };
	return {
		exit: failing(worst) ? 1 : 0,
		reason: `verdict ${worst.status}${worst.blocking ? ", blocking" : ""}`,
		verdict: worst,
	};
}

/**
 * Section 8 and 5: an importing host accepts a check record whose key equals its own run's and, since the tool's version
 * is known only after it runs, compares the version in the payload. READING: the host learns its own version by asking
 * the tool, since running the check would make the import pointless.
 */
export function acceptCheck(
	record: Envelope,
	own: { key: string; toolVersion: string },
): { accepted: boolean; why: string } {
	if (record.key !== own.key) return { accepted: false, why: "the key differs" };
	const version = (record.payload as { record?: { version?: string } }).record?.version;
	if (version === undefined)
		return { accepted: true, why: "the payload names no version, so there is nothing to compare" };
	return version === own.toolVersion
		? { accepted: true, why: "same key and version" }
		: { accepted: false, why: `the record ran ${version}, this host runs ${own.toolVersion}` };
}

/** Section 5: a verification is keyed by its candidate's claim IDs and the verifier's version. */
export function verificationKey(claims: readonly string[], verifier: string): string {
	return `${[...claims].sort().join(",")} ${verifier}`;
}
