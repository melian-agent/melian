import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NamedCredential } from "@melian-agent/core";
import { CredentialError, PiCredentialsError } from "./errors.ts";
import {
	type AuthContext,
	type AuthOperationOptions,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	createProviderModels,
	defaultProviderAuthContext,
} from "./harness.ts";
import { type ReviewModels, wrapModels } from "./models.ts";

/**
 * Where Pi keeps the credentials `/login` saves: `auth.json` in Pi's agent directory, which is `PI_CODING_AGENT_DIR`
 * when set and `~/.pi/agent` otherwise.
 */
export function piAuthPath(env: NodeJS.ProcessEnv = process.env): string {
	const directory = env.PI_CODING_AGENT_DIR;
	if (directory === undefined || directory === "") return join(homedir(), ".pi", "agent", "auth.json");
	return join(directory.replace(/^~(?=$|\/)/, homedir()), "auth.json");
}

type Stored = Record<string, Credential>;

function isCredential(value: unknown): value is Credential {
	if (typeof value !== "object" || value === null) return false;
	const credential = value as Record<string, unknown>;
	if (credential.type === "api_key") return credential.key === undefined || typeof credential.key === "string";
	return (
		credential.type === "oauth" &&
		typeof credential.access === "string" &&
		typeof credential.refresh === "string" &&
		typeof credential.expires === "number"
	);
}

// pi-ai refreshes an OAuth token with less than five minutes left (DEFAULT_OAUTH_MINIMUM_VALIDITY_MS in its
// auth/resolve.js); the margin covers a review that starts just before the window.
const oauthRefreshWindowMs = 5 * 60_000;
const oauthMarginMs = 2 * 60_000;

// Pi resolves `!command` keys by running them and `$VAR` keys from the environment. Melian does neither, so such a
// key reads as absent and the provider's environment variable applies instead. An OAuth login inside pi-ai's refresh
// window reads as absent too: pi-ai would refresh it before use, which needs a write, and its checkAuth does not look
// at expiry, so model selection would otherwise pick a provider whose every request then fails.
function usable(credential: Credential): Credential | undefined {
	if (credential.type === "oauth") {
		return Date.now() + oauthRefreshWindowMs + oauthMarginMs < credential.expires ? credential : undefined;
	}
	if (credential.key === undefined) return credential;
	return credential.key.startsWith("!") || credential.key.includes("$") ? undefined : credential;
}

/**
 * Pi's credential store, read-only, so one `pi` login covers Melian. It reads `auth.json` afresh on every call, so a
 * token Pi refreshed is seen at once. It never writes: refreshing an OAuth token would rotate the refresh token Pi
 * holds, so a login that has expired, or expires within pi-ai's five-minute refresh window plus two minutes, reads as
 * absent, and the provider's environment variable or the next model applies. A refresh pi-ai attempts anyway is a
 * {@link PiCredentialsError} `readOnly` asking for Pi to be run. A missing file holds no credentials.
 */
export class PiCredentialStore implements CredentialStore {
	/** The `auth.json` it reads; {@link piAuthPath} by default. */
	readonly path: string;

	constructor(path: string = piAuthPath()) {
		this.path = path;
	}

	async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const credential = (await this.load())[provider];
		return credential === undefined ? undefined : usable(structuredClone(credential));
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return Object.entries(await this.load()).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	async modify(
		provider: string,
		_change: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		throw this.readOnly(provider);
	}

	async delete(provider: string, _options?: AuthOperationOptions): Promise<void> {
		throw this.readOnly(provider);
	}

	private async load(): Promise<Stored> {
		const { path } = this;
		const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
			throw new PiCredentialsError("unreadable", path, `${path}: ${error.message}`, { cause: error });
		});
		if (text === undefined) return {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
		} catch {
			// No cause: V8's SyntaxError quotes the text around the fault, which may be part of a key.
			throw new PiCredentialsError("invalid", path, `${path} is not JSON`);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new PiCredentialsError("invalid", path, `${path} must hold an object of credentials by provider`);
		}
		for (const [provider, credential] of Object.entries(parsed)) {
			if (!isCredential(credential)) {
				throw new PiCredentialsError(
					"invalid",
					path,
					`${path}: the credential for ${provider} is not one Pi writes`,
				);
			}
		}
		return parsed as Stored;
	}

	private readOnly(provider: string): PiCredentialsError {
		return new PiCredentialsError(
			"readOnly",
			this.path,
			`Melian reads ${this.path} without writing it; run pi to refresh the ${provider} login, or set the provider's API key in the environment`,
		);
	}
}

// Long enough for a password manager to ask for a fingerprint, short enough that a hung command fails the review.
const commandTimeoutMs = 60_000;
// Far more than any key; a command printing more is not printing a key.
const commandOutputBytes = 64 * 1024;

function runCommand(credential: NamedCredential, command: string): Promise<string> {
	const { name, file } = credential;
	return new Promise((resolve, reject) => {
		execFile(
			"/bin/sh",
			["-c", command],
			{ timeout: commandTimeoutMs, maxBuffer: commandOutputBytes },
			(error, stdout) => {
				// Never the command's output in a message: what it printed may be the key, or part of it.
				if (error !== null) {
					const how =
						(error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
							? `printed more than ${commandOutputBytes / 1024} KiB`
							: error.killed
								? `did not finish in ${commandTimeoutMs / 1000} seconds`
								: `failed (${error.code ?? error.signal})`;
					reject(
						new CredentialError("commandFailed", `credential ${name} in ${file}: its command ${how}`, {
							credential: name,
							file,
						}),
					);
					return;
				}
				resolve(stdout.trim());
			},
		);
	});
}

/**
 * The credentials a review reads: the named credentials of the secrets files first, in their order, then Pi's store.
 * The provider's environment variables apply after both, as pi-ai resolves them. A named credential applies when its
 * source is present: a literal key, an environment variable that is set, or a command, which counts as present until
 * it runs, at its provider's first use, once per process. Like Pi's store it never writes.
 */
export class MelianCredentialStore implements CredentialStore {
	readonly named: readonly NamedCredential[];
	readonly pi: PiCredentialStore;
	readonly #env: NodeJS.ProcessEnv;
	readonly #values = new Map<NamedCredential, Promise<string>>();

	constructor(named: readonly NamedCredential[], pi: PiCredentialStore = new PiCredentialStore(), env = process.env) {
		this.named = named;
		this.pi = pi;
		this.#env = env;
	}

	/** The named credential that applies to `provider`, if any. */
	credential(provider: string): NamedCredential | undefined {
		return this.named.find(
			(credential) =>
				credential.provider === provider &&
				(credential.value.kind !== "env" || (this.#env[credential.value.variable] ?? "") !== ""),
		);
	}

	/** Where `provider`'s credential comes from, if this store holds one: a named credential and its file, or Pi's login. */
	async describe(provider: string): Promise<string | undefined> {
		const named = this.credential(provider);
		if (named !== undefined) return `${named.name} in ${named.file}`;
		const stored = await this.pi.read(provider).catch(() => undefined);
		return stored === undefined ? undefined : `Pi's login in ${this.pi.path}`;
	}

	/** The value of `provider`'s named credential, running its command if it has one. */
	async value(credential: NamedCredential): Promise<string> {
		let value = this.#values.get(credential);
		if (value === undefined) {
			const source = credential.value;
			value =
				source.kind === "literal"
					? Promise.resolve(source.key)
					: source.kind === "env"
						? Promise.resolve(this.#env[source.variable] ?? "")
						: runCommand(credential, source.command);
			this.#values.set(credential, value);
		}
		const resolved = await value;
		if (resolved === "") {
			const { name, file } = credential;
			throw new CredentialError("noValue", `credential ${name} in ${file} gave an empty value`, {
				credential: name,
				file,
			});
		}
		return resolved;
	}

	async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const named = this.credential(provider);
		if (named === undefined) return this.pi.read(provider, options);
		return { type: "api_key", key: await this.value(named) };
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const stored = await this.pi.list(options);
		const named = this.named.flatMap((credential) =>
			this.credential(credential.provider) === credential
				? [{ providerId: credential.provider, type: "api_key" as const }]
				: [],
		);
		return [...named, ...stored.filter((each) => !named.some((other) => other.providerId === each.providerId))];
	}

	modify(
		provider: string,
		change: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.pi.modify(provider, change, options);
	}

	delete(provider: string, options?: AuthOperationOptions): Promise<void> {
		return this.pi.delete(provider, options);
	}
}

/** Creates a {@link PiCredentialStore} over `path`, as `new PiCredentialStore(path)` does. */
export function piCredentialStore(path: string = piAuthPath()): PiCredentialStore {
	return new PiCredentialStore(path);
}

// Claude Code keeps the same kind of Anthropic OAuth token under its own name, so a Claude Code user needs no copy.
const environmentAliases: Readonly<Record<string, string>> = { ANTHROPIC_OAUTH_TOKEN: "CLAUDE_CODE_OAUTH_TOKEN" };

function reviewAuthContext(): AuthContext {
	const base = defaultProviderAuthContext();
	return {
		async env(name) {
			const alias = environmentAliases[name];
			return (await base.env(name)) ?? (alias === undefined ? undefined : base.env(alias));
		},
		fileExists: (path) => base.fileExists(path),
	};
}

/**
 * The model collection a review runs on: every pi-ai built-in provider, each resolving its credentials from the named
 * `credentials` of the secrets files first, then Pi's credential store, then its environment variables, as pi-ai does.
 * `CLAUDE_CODE_OAUTH_TOKEN` stands in for an unset `ANTHROPIC_OAUTH_TOKEN`. `authPath` overrides where Pi's store is.
 * Throws {@link CredentialError} `unknownProvider` for a named credential whose provider the catalogue does not know.
 */
export function createReviewModels(
	options: { readonly authPath?: string; readonly credentials?: readonly NamedCredential[] } = {},
): ReviewModels {
	const store = new MelianCredentialStore(options.credentials ?? [], new PiCredentialStore(options.authPath));
	const models = createProviderModels(store, reviewAuthContext());
	// A provider pi-ai does not know, such as a misspelt one, would leave the credential unused without a word.
	for (const { name, provider, file } of store.named) {
		if (models.getProvider(provider) !== undefined) continue;
		throw new CredentialError(
			"unknownProvider",
			`credential ${name} in ${file} names the provider ${provider}, which Melian's model catalogue does not know`,
			{ credential: name, file },
		);
	}
	return wrapModels(models, store);
}
