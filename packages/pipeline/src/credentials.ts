import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type NamedCredential, visibleText } from "@melian-agent/core";
import { CredentialError, PiCredentialsError } from "./errors.ts";
import {
	type AuthContext,
	type AuthOperationOptions,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	createProviderModels,
	defaultProviderAuthContext,
	type MutableModels,
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
						new CredentialError(
							"commandFailed",
							`credential ${visibleText(name)} in ${visibleText(file)}: its command ${how}`,
							{
								credential: name,
								file,
							},
						),
					);
					return;
				}
				resolve(stdout.trim());
			},
		);
	});
}

function bearerExpiry(value: string): number {
	const now = Date.now();
	const parts = value.split(".");
	if (parts.length === 3) {
		try {
			const claims: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
			if (typeof claims === "object" && claims !== null && "exp" in claims) {
				const expires = claims.exp;
				if (
					typeof expires === "number" &&
					Number.isFinite(expires * 1000) &&
					expires * 1000 <= now + 30 * 24 * 60 * 60_000
				)
					return expires * 1000;
			}
		} catch {}
	}
	return now + 60 * 60_000;
}

/** The authentication kinds a provider accepts, read from the model collection's registry. */
export interface ProviderAuthKinds {
	readonly apiKey: boolean;
	readonly oauth: boolean;
}

/**
 * The credentials a review reads: usable named credentials in precedence order, then Pi's store. The provider's
 * environment variables apply after both, as pi-ai resolves them. Unread commands count as present during planning;
 * unlocking runs a selected command once per process and refuses an unusable bearer before review storage opens.
 * API-key providers receive a key; OAuth-only providers receive a bearer with no refresh token. JWT expiry is read
 * without signature verification and bounded to 30 days ahead. Other values get a rolling one-hour lease on every
 * read. A bearer inside the seven-minute cutoff reads as absent. Like Pi's store it never writes.
 */
export class MelianCredentialStore implements CredentialStore {
	readonly named: readonly NamedCredential[];
	readonly pi: PiCredentialStore;
	readonly #env: NodeJS.ProcessEnv;
	readonly #authKinds: (provider: string) => ProviderAuthKinds;
	readonly #values = new Map<NamedCredential, Promise<string>>();

	constructor(
		named: readonly NamedCredential[],
		authKinds: (provider: string) => ProviderAuthKinds,
		pi: PiCredentialStore = new PiCredentialStore(),
		env = process.env,
	) {
		this.named = named;
		this.pi = pi;
		this.#env = env;
		this.#authKinds = authKinds;
	}

	/** The first usable named credential for `provider`; unread commands are provisional unless `runCommands` is set. */
	async credential(provider: string, runCommands = false): Promise<NamedCredential | undefined> {
		if (this.type(provider) === undefined) return undefined;
		for (const credential of this.named) {
			if (credential.provider !== provider) continue;
			if (credential.value.kind === "env" && (this.#env[credential.value.variable] ?? "") === "") continue;
			if (credential.value.kind === "command" && !runCommands && !this.#values.has(credential)) return credential;
			if ((await this.resolve(credential)) !== undefined) return credential;
		}
		return undefined;
	}

	/** Where `provider`'s credential comes from, if this store holds one: a named credential and its file, or Pi's login. */
	async describe(provider: string): Promise<string | undefined> {
		const named = await this.credential(provider);
		if (named !== undefined) return `${named.name} in ${named.file}`;
		const stored = await this.pi.read(provider).catch(() => undefined);
		const auth = this.#authKinds(provider);
		const accepted = stored?.type === "api_key" ? auth.apiKey : stored?.type === "oauth" && auth.oauth;
		return accepted ? `Pi's login in ${this.pi.path}` : undefined;
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
			throw new CredentialError(
				"noValue",
				`credential ${visibleText(name)} in ${visibleText(file)} gave an empty value`,
				{
					credential: name,
					file,
				},
			);
		}
		return resolved;
	}

	/** Unlocks the selected named source and refuses an unusable bearer before a review starts. */
	async unlock(provider: string): Promise<void> {
		const named = await this.credential(provider);
		if (named === undefined) return;
		if ((await this.resolve(named)) === undefined) {
			throw new CredentialError(
				"tokenExpired",
				`credential ${visibleText(named.name)} in ${visibleText(named.file)}: its token has expired; refresh it with the tool that owns it`,
				{ credential: named.name, file: named.file },
			);
		}
	}

	async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const named = await this.credential(provider, true);
		if (named === undefined) return this.pi.read(provider, options);
		return (await this.resolve(named)) ?? this.pi.read(provider, options);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const stored = await this.pi.list(options);
		const named: CredentialInfo[] = [];
		for (const providerId of new Set(this.named.map((credential) => credential.provider))) {
			if ((await this.credential(providerId)) !== undefined) {
				named.push({ providerId, type: this.type(providerId)! });
			}
		}
		return [...named, ...stored.filter((each) => !named.some((other) => other.providerId === each.providerId))];
	}

	private type(provider: string): Credential["type"] | undefined {
		const auth = this.#authKinds(provider);
		return auth.apiKey ? "api_key" : auth.oauth ? "oauth" : undefined;
	}

	private async resolve(named: NamedCredential): Promise<Credential | undefined> {
		const value = await this.value(named);
		if (this.type(named.provider) === "api_key") return { type: "api_key", key: value };
		return usable({ type: "oauth", access: value, refresh: "", expires: bearerExpiry(value) });
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
 * Throws {@link CredentialError} `unknownProvider` for a named credential whose provider the catalogue does not know,
 * or `unsupportedAuth` when it accepts neither API keys nor OAuth tokens.
 */
export function createReviewModels(
	options: { readonly authPath?: string; readonly credentials?: readonly NamedCredential[] } = {},
): ReviewModels {
	let models: MutableModels;
	const store = new MelianCredentialStore(
		options.credentials ?? [],
		(id) => {
			const auth = models.getProvider(id)?.auth;
			return { apiKey: auth?.apiKey !== undefined, oauth: auth?.oauth !== undefined };
		},
		new PiCredentialStore(options.authPath),
	);
	models = createProviderModels(store, reviewAuthContext());
	// A provider pi-ai does not know, such as a misspelt one, would leave the credential unused without a word.
	for (const { name, provider, file } of store.named) {
		const known = models.getProvider(provider);
		if (known !== undefined) {
			if (known.auth.apiKey !== undefined || known.auth.oauth !== undefined) continue;
			throw new CredentialError(
				"unsupportedAuth",
				`credential ${visibleText(name)} in ${visibleText(file)} names the provider ${visibleText(provider)}, which accepts neither API keys nor OAuth tokens`,
				{ credential: name, file },
			);
		}
		throw new CredentialError(
			"unknownProvider",
			// A secrets file's names reach a terminal, so they print escaped.
			`credential ${visibleText(name)} in ${visibleText(file)} names the provider ${visibleText(provider)}, which Melian's model catalogue does not know`,
			{ credential: name, file },
		);
	}
	return wrapModels(models, store);
}
