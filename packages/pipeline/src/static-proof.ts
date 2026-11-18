import { KeyedRequest, type RecordJson } from "@melian-agent/core";
import { type CheckRequestInput, checkReusable, writesFixedText } from "./check-request.ts";
import {
	type CheckRunRecord,
	CheckSources,
	ChecksDocument,
	identityKey,
	type RunIdentity,
	readCheckRecords,
} from "./checks.ts";
import { FindingsDocument, type FindingsState, stampOf } from "./findings.ts";
import type { Context, ConversationId, Harness, Tx } from "./harness.ts";

/**
 * What the local store proves about a static check's sightings: that the run whose terminal commit wrote them asked for
 * check code that stores none of its tool's text. It reads the requests, and the check tasks and records a run's own task
 * stored, only from the store, never from a run handed in.
 */
export class StaticProof {
	readonly #requests: Readonly<Record<string, RecordJson>>;
	readonly #tasks: Readonly<Record<string, number>>;
	readonly #records: Readonly<Record<string, CheckRunRecord>>;

	private constructor(
		requests: Readonly<Record<string, RecordJson>>,
		tasks: Readonly<Record<string, number>>,
		records: Readonly<Record<string, CheckRunRecord>>,
	) {
		this.#requests = requests;
		this.#tasks = tasks;
		this.#records = records;
	}

	/**
	 * Reads every request the checks document of `root` stores, and, for the run `run`, its records and the check task it
	 * recorded for each check: the one it started, or for a check a rerun kept, the task the kept record came from.
	 */
	static async read(
		harness: Pick<Harness, "snapshot">,
		root: ConversationId,
		context: Context,
		run?: RunIdentity,
	): Promise<StaticProof> {
		const document = await harness.snapshot(ChecksDocument, root, context);
		if (run === undefined) return new StaticProof(structuredClone(document?.requests ?? {}), {}, {});
		const sources = await harness.snapshot(CheckSources, root, String(run.task), context);
		return new StaticProof(
			structuredClone(document?.requests ?? {}),
			structuredClone(sources?.tasks ?? {}),
			await readCheckRecords(harness, root, run, context),
		);
	}

	/**
	 * What a commit's own view of `root` proves about the run `run`, or about no run when it is absent, and the findings state that view holds, so a proof
	 * and the sightings it judges come from one read, inside the commit that decides on them.
	 */
	static async inCommit(
		tx: Tx,
		root: ConversationId,
		run: RunIdentity | undefined,
	): Promise<{ proof: StaticProof; state: FindingsState }> {
		// A commit's document view refuses structuredClone, so the copies go through JSON.
		const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
		const document = await tx.doc(ChecksDocument, root);
		const sources = run === undefined ? undefined : await tx.doc(CheckSources, root, String(run.task), null);
		const proof = new StaticProof(
			copy(document.requests ?? {}),
			copy(sources?.tasks ?? {}),
			run === undefined ? {} : copy(document.runs[identityKey(run)] ?? {}),
		);
		return { proof, state: copy(await tx.doc(FindingsDocument, root)) as FindingsState };
	}

	/**
	 * The static checks among `checks` that count as run, `ran` or `provisional`, whose sightings at `revision` this proof
	 * does not show the run under `request` wrote. Another run has replaced them since, or the run never stamped them.
	 */
	replaced(
		state: FindingsState | undefined,
		revision: string,
		checks: readonly { readonly name: string; readonly status: string }[],
		request: string,
	): string[] {
		return checks
			.filter(({ name, status }) => name.startsWith("static.") && (status === "ran" || status === "provisional"))
			.filter(({ name }) => !this.proves(state, revision, name, request))
			.map(({ name }) => name);
	}

	/** The record the run read at `read` stored for `check`, which a caller's record of it never stands in for. */
	recorded(check: string): CheckRunRecord | undefined {
		return Object.hasOwn(this.#records, check) ? this.#records[check] : undefined;
	}

	/**
	 * Whether every sighting `check` has at `revision` was written by the one check task the run read at `read` recorded
	 * for it, under `request`, and that run asked for check code that stores none of its tool's text. Two executions of
	 * one request stamp the same key, so the key alone names no one execution.
	 */
	proves(state: FindingsState | undefined, revision: string, check: string, request: string): boolean {
		const stamp = stampOf(state, revision, check);
		return (
			stamp?.request === request &&
			Object.hasOwn(this.#tasks, check) &&
			stamp.task === this.#tasks[check] &&
			this.asks(check, request)
		);
	}

	/** Whether the stored request under `request` hashes to that key and asks for a version of `check` that stores no tool text. */
	asks(check: string, request: string | undefined): boolean {
		if (request === undefined || !Object.hasOwn(this.#requests, request)) return false;
		let rehashed: KeyedRequest<RecordJson>;
		try {
			rehashed = KeyedRequest.of("check", this.#requests[request]);
		} catch {
			// A stored request canonical JSON refuses was not written by a run; it proves nothing.
			return false;
		}
		return rehashed.key === request && writesFixedText(rehashed, check);
	}

	/**
	 * Whether the stored request under `request` keyed everything its run read, by `checkReusable`. A request that did not
	 * starts a new run each time it is asked, so a later run under the same key can replace the sightings an earlier run's
	 * record describes, and stamp the same key.
	 */
	keyedFully(request: string): boolean {
		try {
			return (
				checkReusable(this.#requests[request] as unknown as Pick<CheckRequestInput, "policy" | "install">) === true
			);
		} catch {
			// A stored request with no install facts to read was not keyed by a run of this build; it keys nothing fully.
			return false;
		}
	}
}
