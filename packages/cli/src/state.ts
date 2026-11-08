import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type LoadedSecrets, loadSecrets, type NamedCredential, userFiles, visibleText } from "@melian-agent/core";
import {
	backgroundContext as context,
	MelianCredentialStore,
	openJsonlStorage,
	type Storage,
} from "@melian-agent/pipeline";
import {
	CopyInUse,
	LeaseHeld,
	StateBranch,
	StateBranchError,
	type StateCheckout,
	type StateReservation,
} from "@melian-agent/state-git";
import type { Io } from "./commands.ts";
import { isScripted } from "./models.ts";
import { CliError, openStorage, storagePath } from "./repository.ts";

/** The provider a secrets file names for the state branch's writers' key, which no model uses. */
export const stateKeyProvider = "melian-state";

/** The secrets files' credentials without the state key, for the model catalogue, which would refuse its provider. */
export function modelCredentials(secrets: LoadedSecrets): readonly NamedCredential[] {
	return secrets.credentials.filter((credential) => credential.provider !== stateKeyProvider);
}

// Where a changeset's storage lives: one SQLite file for a range, for scripted mode and for a pull request first
// reviewed before the state branch, and this clone's copy of the branch's JSONL storage for any other pull request.
type Location =
	| { readonly kind: "sqlite"; readonly path: string; readonly legacy: boolean }
	| { readonly kind: "state"; readonly directory: string };

// `directory`, when given, is the state directory the caller already resolved.
async function locate(
	repoRoot: string,
	changeset: string,
	env: NodeJS.ProcessEnv,
	directory?: string,
): Promise<Location> {
	const scripted = isScripted(env);
	const path =
		directory === undefined
			? await storagePath(repoRoot, changeset, env, scripted)
			: join(directory, `${changeset}.sqlite`);
	// Scripted mode's stores never leave the clone, so they stay where its tests find them.
	if (scripted || !changeset.startsWith("pull-")) return { kind: "sqlite", path, legacy: false };
	if (existsSync(path)) return { kind: "sqlite", path, legacy: true };
	return { kind: "state", directory: join(dirname(path), "state") };
}

// This clone's name on the state branch, made once, so a crashed run's lease is this clone's to take over.
async function holder(directory: string): Promise<string> {
	const path = join(directory, "holder");
	const existing = await readFile(path, "utf8").catch(() => undefined);
	if (existing?.trim()) return existing.trim();
	await mkdir(directory, { recursive: true });
	await writeFile(path, `${randomUUID()}\n`, { flag: "wx" }).catch(() => {});
	return (await readFile(path, "utf8")).trim();
}

// The writers' key from the secrets files, as 64 hex digits or 32 bytes in base64; undefined when none names one.
async function stateKey(repoRoot: string, env: NodeJS.ProcessEnv): Promise<Uint8Array | undefined> {
	const secrets = await loadSecrets(repoRoot, userFiles(env).secrets);
	const credential = secrets.credentials.find((each) => each.provider === stateKeyProvider);
	// An unset variable names no key, as it names no model credential, and as doctor reports it.
	if (credential === undefined || (credential.value.kind === "env" && (env[credential.value.variable] ?? "") === ""))
		return undefined;
	const value = (
		await new MelianCredentialStore(
			secrets.credentials,
			() => ({ apiKey: true, oauth: false }),
			undefined,
			env,
		).value(credential)
	).trim();
	const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
	if (key.length !== 32 || (!/^[0-9a-f]{64}$/i.test(value) && key.toString("base64") !== value))
		throw new CliError(
			`credential ${visibleText(credential.name)} in ${visibleText(credential.file)} is not a state key: give 64 hex digits or 32 bytes in base64`,
		);
	return key;
}

/**
 * A changeset's storage, opened for one command. A pull request's storage is this clone's copy of the state branch's,
 * under the copy's lock: a command that writes it takes the branch's lease first and stores the copy back when it
 * closes, and a command that reads it touches no remote.
 */
// Opens a copy with Pi's storage, which refuses one whose committed records are missing, so a damaged copy is set aside
// for the branch's rather than pushed over it.
async function validate(directory: string): Promise<void> {
	await (await openJsonlStorage(directory, context)).close(context);
}

// A pull request's storage whose commits and the checkpoint's snapshots take turns. Pi writes a commit's sidecars, then
// its marker in the main log, then reclaims sidecars, so a snapshot read during a commit could push a marker without
// the records it names. Pi serialises every write through `commit`, so holding it is enough.
class SerialStorage implements Storage {
	readonly #inner: Storage;
	#turn: Promise<unknown> = Promise.resolve();
	// Generic and overloaded, so bound rather than spelt out.
	readonly mintId: Storage["mintId"];
	readonly entry: Storage["entry"];

	constructor(inner: Storage) {
		this.#inner = inner;
		this.mintId = inner.mintId.bind(inner);
		this.entry = inner.entry.bind(inner);
	}

	/** Runs `work` once no commit is in flight, and holds every later commit until it ends. */
	exclusive<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#turn.then(work);
		this.#turn = run.catch(() => undefined);
		return run;
	}

	commit(...args: Parameters<Storage["commit"]>): ReturnType<Storage["commit"]> {
		return this.exclusive(() => this.#inner.commit(...args));
	}

	close(...args: Parameters<Storage["close"]>): ReturnType<Storage["close"]> {
		return this.#inner.close(...args);
	}

	conversation(...args: Parameters<Storage["conversation"]>): ReturnType<Storage["conversation"]> {
		return this.#inner.conversation(...args);
	}

	scanConversations(...args: Parameters<Storage["scanConversations"]>): ReturnType<Storage["scanConversations"]> {
		return this.#inner.scanConversations(...args);
	}

	findLatestHeadMarker(
		...args: Parameters<Storage["findLatestHeadMarker"]>
	): ReturnType<Storage["findLatestHeadMarker"]> {
		return this.#inner.findLatestHeadMarker(...args);
	}

	scanEntries(...args: Parameters<Storage["scanEntries"]>): ReturnType<Storage["scanEntries"]> {
		return this.#inner.scanEntries(...args);
	}

	task(...args: Parameters<Storage["task"]>): ReturnType<Storage["task"]> {
		return this.#inner.task(...args);
	}

	scanTasks(...args: Parameters<Storage["scanTasks"]>): ReturnType<Storage["scanTasks"]> {
		return this.#inner.scanTasks(...args);
	}

	submission(...args: Parameters<Storage["submission"]>): ReturnType<Storage["submission"]> {
		return this.#inner.submission(...args);
	}

	scanSubmissions(...args: Parameters<Storage["scanSubmissions"]>): ReturnType<Storage["scanSubmissions"]> {
		return this.#inner.scanSubmissions(...args);
	}

	submissionByRequest(
		...args: Parameters<Storage["submissionByRequest"]>
	): ReturnType<Storage["submissionByRequest"]> {
		return this.#inner.submissionByRequest(...args);
	}

	findDocument(...args: Parameters<Storage["findDocument"]>): ReturnType<Storage["findDocument"]> {
		return this.#inner.findDocument(...args);
	}

	document(...args: Parameters<Storage["document"]>): ReturnType<Storage["document"]> {
		return this.#inner.document(...args);
	}

	scanDocuments(...args: Parameters<Storage["scanDocuments"]>): ReturnType<Storage["scanDocuments"]> {
		return this.#inner.scanDocuments(...args);
	}
}

export class ChangesetStore {
	readonly storage: Storage;
	readonly #checkout: StateCheckout | undefined;
	readonly #io: Io;
	readonly #authoritative: boolean;
	#reservation: StateReservation | undefined;

	private constructor(storage: Storage, checkout: StateCheckout | undefined, io: Io, authoritative = false) {
		this.storage = storage;
		this.#checkout = checkout;
		this.#io = io;
		this.#authoritative = authoritative;
	}

	/**
	 * Whether the changeset may hold a stored review: its SQLite file exists, or it is a pull request's, whose copy a
	 * writer may yet take from the state branch.
	 */
	static async exists(io: Io, repoRoot: string, changeset: string, directory?: string): Promise<boolean> {
		const location = await locate(repoRoot, changeset, io.env, directory);
		return location.kind === "state" || existsSync(location.path);
	}

	/**
	 * Opens the changeset's storage for a command that writes it, creating it when absent. An `authoritative` command
	 * refuses a pull request's copy it could not lease from the state branch.
	 */
	static async write(
		io: Io,
		repoRoot: string,
		changeset: string,
		directory?: string,
		options: { readonly authoritative?: boolean } = {},
	): Promise<ChangesetStore> {
		const location = await locate(repoRoot, changeset, io.env, directory);
		if (location.kind === "sqlite") {
			const reservation =
				location.legacy && options.authoritative === true
					? await ChangesetStore.#reserve(io, repoRoot, changeset)
					: undefined;
			return ChangesetStore.#sqlite(io, location, changeset, reservation);
		}
		const branch = new StateBranch({
			repoRoot,
			remote: "origin",
			directory: location.directory,
			holder: await holder(location.directory),
			key: await stateKey(repoRoot, io.env),
			validate,
		});
		const checkout = await branch.checkout(changeset).catch(ChangesetStore.#refusal);
		// A command that acts on GitHub needs the branch's latest copy: this clone's alone may lack a newer round that
		// another clone pushed, and publishing it would replace that round's status.
		if (options.authoritative === true && checkout.unreached !== undefined) {
			checkout.close();
			throw new CliError(
				`melian publish needs the pull request's storage from melian/state, which this clone could not lease: ${visibleText(checkout.unreached)}; set the writers' key in a secrets file, and publish where the branch is in reach`,
			);
		}
		if (checkout.unreached !== undefined)
			io.stderr(
				`melian: ${visibleText(checkout.unreached)}; this command works in this clone's copy of the pull request's storage, and a later command that reaches melian/state stores it\n`,
			);
		if (checkout.setAside !== undefined)
			io.stderr(
				`melian: another run stored this pull request on melian/state since this clone did; its copy is set aside at ${visibleText(checkout.setAside)}, and this command carries on from the branch's\n`,
			);
		return ChangesetStore.#opened(io, checkout, options.authoritative === true);
	}

	/** Takes a pull request's copy from the state branch when another run stored it since, and changes nothing else. */
	static async restore(io: Io, repoRoot: string, changeset: string): Promise<void> {
		if ((await locate(repoRoot, changeset, io.env)).kind !== "state") return;
		const store = await ChangesetStore.write(io, repoRoot, changeset);
		await store.storage.close(context);
		await store.close();
	}

	/** Opens the changeset's storage for a command that only reads it, or undefined when none is stored here. */
	static async read(
		io: Io,
		repoRoot: string,
		changeset: string,
		directory?: string,
	): Promise<ChangesetStore | undefined> {
		const location = await locate(repoRoot, changeset, io.env, directory);
		if (location.kind === "sqlite")
			return existsSync(location.path) ? ChangesetStore.#sqlite(io, location, changeset) : undefined;
		const branch = new StateBranch({
			repoRoot,
			remote: "origin",
			directory: location.directory,
			holder: "reader",
			validate,
		});
		const checkout = await branch.open(changeset).catch(ChangesetStore.#refusal);
		return checkout === undefined ? undefined : ChangesetStore.#opened(io, checkout);
	}

	static async #sqlite(
		io: Io,
		location: { readonly path: string; readonly legacy: boolean },
		changeset: string,
		reservation?: StateReservation,
	): Promise<ChangesetStore> {
		if (location.legacy)
			io.stderr(
				`melian: ${changeset} keeps the SQLite storage it had before the state branch, in this clone alone\n`,
			);
		const storage = await openStorage(location.path).catch(async (error: unknown) => {
			await reservation?.release().catch(() => {});
			throw error;
		});
		const store = new ChangesetStore(storage, undefined, io);
		store.#reservation = reservation;
		return store;
	}

	// A clone's SQLite storage from before the state branch is the pull request's only copy until another clone stores
	// the pull request on the branch; from then on the two disagree, and publishing the older would replace the newer.
	// So a publication from it holds the pull request's lease, which another clone's write then cannot take.
	static async #reserve(io: Io, repoRoot: string, changeset: string): Promise<StateReservation> {
		// The copies' directory, where a checkout of the pull request in this clone would take the same lock.
		const directory = join(dirname(await storagePath(repoRoot, changeset, io.env, false)), "state");
		const branch = new StateBranch({
			repoRoot,
			remote: "origin",
			directory,
			holder: await holder(directory),
			key: await stateKey(repoRoot, io.env),
			validate,
		});
		return branch.reserve(changeset).catch((error: unknown) => {
			if (error instanceof StateBranchError && error.code === "storedElsewhere")
				throw new CliError(
					`${changeset} has SQLite storage in this clone from before the state branch, and melian/state holds the pull request too; publish it from a clone that holds the branch's copy`,
				);
			if (error instanceof StateBranchError && error.code !== "invalidBranch")
				throw new CliError(
					`melian publish needs the pull request's storage from melian/state, which this clone could not lease: ${visibleText(error.message)}; set the writers' key in a secrets file, and publish where the branch is in reach`,
				);
			return ChangesetStore.#refusal(error);
		});
	}

	static async #opened(io: Io, checkout: StateCheckout, authoritative = false): Promise<ChangesetStore> {
		try {
			const storage = new SerialStorage(await openJsonlStorage(checkout.directory, context));
			return new ChangesetStore(storage, checkout, io, authoritative);
		} catch (error) {
			checkout.close();
			throw error;
		}
	}

	static #refusal(error: unknown): never {
		if (error instanceof LeaseHeld || error instanceof CopyInUse) throw new CliError(error.message);
		throw error;
	}

	/**
	 * Stores the copy on the branch and renews the lease, before each write a command makes to GitHub, so another clone
	 * that takes the pull request over finds the publisher secret that signed what it posted, and a run that lost the
	 * lease posts nothing more.
	 */
	async checkpoint(): Promise<void> {
		const checkout = this.#checkout;
		const pushed =
			checkout !== undefined
				? this.storage instanceof SerialStorage
					? await this.storage.exclusive(() => ChangesetStore.#push(checkout, { keepLease: true }))
					: await ChangesetStore.#push(checkout, { keepLease: true })
				: this.#reservation === undefined
					? ({ kind: "pushed" } as const)
					: await this.#reservation.confirm().catch((error: unknown) => {
							if (
								error instanceof StateBranchError &&
								(error.code === "fetchFailed" || error.code === "pushFailed")
							)
								return { kind: "refused", reason: error.message } as const;
							throw error;
						});
		if (pushed.kind !== "pushed" && pushed.kind !== "confirmed")
			throw new CliError(
				`melian publish could not store the pull request's storage on melian/state before posting: ${visibleText(pushed.reason)}; nothing more was posted`,
			);
	}

	// Only a branch out of reach leaves the copy for later; a copy or branch this build cannot store fails the command.
	static #push(checkout: StateCheckout, options: { readonly keepLease?: boolean } = {}) {
		return checkout.push(options).catch((error: unknown) => {
			if (error instanceof StateBranchError && (error.code === "fetchFailed" || error.code === "pushFailed"))
				return { kind: "unreached", reason: error.message } as const;
			throw error;
		});
	}

	/**
	 * Releases the copy, after the harness has closed the storage, storing it on the branch first when the command
	 * wrote it. A store the branch refuses stays in this clone; the next command takes the branch's.
	 */
	async close(): Promise<void> {
		const checkout = this.#checkout;
		// A reservation's lease expires on its own if the branch is out of reach now.
		if (checkout === undefined) {
			await this.#reservation?.release().catch(() => {});
			return;
		}
		try {
			const pushed = await ChangesetStore.#push(checkout);
			// GitHub already holds what an authoritative command posted, so a store left behind fails it.
			if (this.#authoritative && pushed.kind !== "pushed")
				throw new CliError(
					`GitHub has this publication, but melian/state did not take its storage: ${visibleText(pushed.reason)}; this clone keeps it, and melian publish run again here stores it`,
				);
			if (pushed.kind === "refused")
				this.#io.stderr(
					`melian: melian/state refused this command's storage: ${visibleText(pushed.reason)}; this clone keeps it, and the next command carries on from the branch's copy\n`,
				);
			else if (pushed.kind === "unreached" && pushed.reason !== checkout.unreached)
				this.#io.stderr(
					`melian: melian/state is out of reach: ${visibleText(pushed.reason)}; this clone keeps the pull request's storage, and a later command that reaches the branch stores it\n`,
				);
		} finally {
			checkout.close();
		}
	}
}
