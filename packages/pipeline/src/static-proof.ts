import { KeyedRequest, type RecordJson } from "@melian-agent/core";
import { type CheckRequestInput, checkReusable, writesFixedText } from "./check-request.ts";
import { CheckSources, ChecksDocument } from "./checks.ts";
import { type FindingsState, stampOf } from "./findings.ts";
import type { Context, ConversationId, Harness } from "./harness.ts";

/**
 * What the local store proves about a static check's sightings: that the run whose terminal commit wrote them asked for
 * check code that stores none of its tool's text. It reads the requests, and the check tasks a run's own task recorded,
 * only from the store, never from a run handed in.
 */
export class StaticProof {
	readonly #requests: Readonly<Record<string, RecordJson>>;
	readonly #tasks: Readonly<Record<string, number>>;

	private constructor(requests: Readonly<Record<string, RecordJson>>, tasks: Readonly<Record<string, number>>) {
		this.#requests = requests;
		this.#tasks = tasks;
	}

	/**
	 * Reads every request the checks document of `root` stores, and, for the run whose task is `run`, the check task it
	 * recorded for each check: the one it started, or for a check a rerun kept, the task the kept record came from.
	 */
	static async read(
		harness: Pick<Harness, "snapshot">,
		root: ConversationId,
		context: Context,
		run?: number,
	): Promise<StaticProof> {
		const document = await harness.snapshot(ChecksDocument, root, context);
		const sources = run === undefined ? undefined : await harness.snapshot(CheckSources, root, String(run), context);
		return new StaticProof(structuredClone(document?.requests ?? {}), structuredClone(sources?.tasks ?? {}));
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
