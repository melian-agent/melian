import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PiCredentialsError } from "./errors.ts";
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

/** Opens Pi's credential store at `path`, as `new PiCredentialStore(path)` does. */
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
 * The model collection a review runs on: every pi-ai built-in provider, each resolving its credentials from Pi's
 * credential store first and its environment variables second, as pi-ai does. `CLAUDE_CODE_OAUTH_TOKEN` stands in
 * for an unset `ANTHROPIC_OAUTH_TOKEN`. `authPath` overrides where the store is.
 */
export function createReviewModels(options: { readonly authPath?: string } = {}): ReviewModels {
	return wrapModels(createProviderModels(new PiCredentialStore(options.authPath), reviewAuthContext()));
}
