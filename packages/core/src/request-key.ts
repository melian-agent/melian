import { createHash } from "node:crypto";
import { RecordError } from "./errors.ts";
import { canonicalJson, type RecordJson } from "./record.ts";

/**
 * What a producer is given that its key leaves out, each with its reason. These are the only exclusions rule 5 of
 * [the shared record decision](../../../docs/decisions/2026-11-13-shared-record-behind-a-store-port.md) allows, and
 * this table is the one place in code that names them.
 */
export const requestExclusions = {
	nonce: "the boundary nonce differs on every run; the request renders under a fixed one instead",
	language: "the language line changes how a finding reads, never what is found",
	bestEffort: "best-effort context, such as callers, is cut by cost and recorded in the payload as delivered or not",
	chosenBy: "who chose a route or paid for it changes nothing the producer is asked",
} as const;

/** A name {@link requestExclusions} lists. */
export type RequestExclusion = keyof typeof requestExclusions;

/** What a producer is given beyond its keyed request: only fields {@link requestExclusions} names. */
export type UnkeyedInput = { readonly [name in RequestExclusion]?: unknown };

const producerName = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/;
const exclusionList = Object.keys(requestExclusions).join(", ");

/**
 * One request to a producer, built once, with the key a later run matches it by: the SHA-256 of the canonical bytes
 * of the producer's name and the request. A producer reads the request and the unkeyed input from here, so nothing
 * reaches it that the key does not cover or an exclusion does not name.
 */
export class KeyedRequest<Request = RecordJson, Unkeyed extends UnkeyedInput = UnkeyedInput> {
	/** The kind of producer asked, such as `lens` or `check`. */
	readonly producer: string;
	/** Everything the producer is asked that decides its answer. */
	readonly request: Request;
	/** What the producer is given that its key leaves out. */
	readonly unkeyed: Unkeyed;
	/** 64 hex digits; equal keys mean the producer was asked the same thing. */
	readonly key: string;

	private constructor(producer: string, request: Request, unkeyed: Unkeyed, key: string) {
		this.producer = producer;
		this.request = request;
		this.unkeyed = unkeyed;
		this.key = key;
	}

	/**
	 * Keys `request` for `producer`. Throws a {@link RecordError} `invalidRecord` for a producer name that is not
	 * lower-case dotted words, an unkeyed field {@link requestExclusions} does not name, or a request
	 * {@link canonicalJson} refuses.
	 */
	static of<Request, Unkeyed extends UnkeyedInput = Record<never, never>>(
		producer: string,
		request: Request,
		unkeyed?: Unkeyed,
	): KeyedRequest<Request, Unkeyed> {
		if (!producerName.test(producer)) {
			throw new RecordError("invalidRecord", "a producer's name is lower-case dotted words");
		}
		const rest = unkeyed ?? ({} as Unkeyed);
		for (const name of Object.keys(rest)) {
			if (!Object.hasOwn(requestExclusions, name)) {
				throw new RecordError("invalidRecord", `a request's key may leave out only ${exclusionList}, not ${name}`);
			}
		}
		const key = createHash("sha256").update(canonicalJson({ producer, request })).digest("hex");
		return new KeyedRequest(producer, structuredClone(request), rest, key);
	}

	/** Whether `other` asks the same producer the same thing. */
	matches(other: KeyedRequest<unknown, UnkeyedInput>): boolean {
		return this.key === other.key;
	}
}
