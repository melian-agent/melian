import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PiCredentialsError } from "./errors.ts";
import {
	type AuthOperationOptions,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	createProviderModels,
	type Models,
} from "./harness.ts";

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

// Pi resolves `!command` keys by running them and `$VAR` keys from the environment. Melian does neither, so such a
// key reads as absent and the provider's environment variable applies instead. An expired OAuth login reads as absent
// too: refreshing it would need a write, and pi-ai's checkAuth does not look at expiry, so model selection would
// otherwise pick a provider whose every request then fails.
function usable(credential: Credential): Credential | undefined {
	if (credential.type === "oauth") return Date.now() < credential.expires ? credential : undefined;
	if (credential.key === undefined) return credential;
	return credential.key.startsWith("!") || credential.key.includes("$") ? undefined : credential;
}

/**
 * Pi's credential store, read-only, so one `pi` login covers Melian. It reads `auth.json` afresh on every call, so a
 * token Pi refreshed is seen at once. It never writes: refreshing an expired OAuth token would rotate the refresh
 * token Pi holds, so an expired login reads as absent, and the provider's environment variable or the next model
 * applies; a refresh pi-ai attempts anyway is a {@link PiCredentialsError} `readOnly` asking for Pi to be run. A
 * missing file holds no credentials.
 */
export function piCredentialStore(path: string = piAuthPath()): CredentialStore {
	const load = async (): Promise<Stored> => {
		const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
			throw new PiCredentialsError("unreadable", path, `${path}: ${error.message}`, { cause: error });
		});
		if (text === undefined) return {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(text.replace(/^﻿/, ""));
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
	};
	const readOnly = (provider: string) =>
		new PiCredentialsError(
			"readOnly",
			path,
			`Melian reads ${path} without writing it; run pi to refresh the ${provider} login, or set the provider's API key in the environment`,
		);
	return {
		async read(provider: string, options?: AuthOperationOptions) {
			options?.signal?.throwIfAborted();
			const credential = (await load())[provider];
			return credential === undefined ? undefined : usable(structuredClone(credential));
		},
		async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
			options?.signal?.throwIfAborted();
			return Object.entries(await load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
		},
		async modify(provider: string) {
			throw readOnly(provider);
		},
		async delete(provider: string) {
			throw readOnly(provider);
		},
	};
}

/**
 * The model collection a review runs on: every pi-ai built-in provider, each resolving its credentials from Pi's
 * credential store first and its environment variables second, as pi-ai does. `authPath` overrides where the store is.
 */
export function createReviewModels(options: { readonly authPath?: string } = {}): Models {
	return createProviderModels(piCredentialStore(options.authPath));
}
