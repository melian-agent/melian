import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import Type from "typebox";
import { configError, maxConfigBytes, parseYaml, type Site } from "./config.ts";
import { git } from "./git.ts";
import { melianPaths } from "./paths.ts";

const name = Type.String({ minLength: 1 });
const credentialSchema = Type.Object(
	{
		provider: name,
		type: Type.Optional(Type.Literal("api_key")),
		key: Type.Optional(name),
		env: Type.Optional(name),
		command: Type.Optional(name),
	},
	{ additionalProperties: false },
);

/** The JSON Schema of a secrets file. Unknown keys are rejected. */
export const secretsFileSchema = Type.Object(
	{ credentials: Type.Optional(Type.Record(Type.String(), credentialSchema)) },
	{ additionalProperties: false },
);

/** Where a named credential's value comes from: the file itself, an environment variable, or a command's output. */
export type CredentialValue =
	| { readonly kind: "literal"; readonly key: string }
	| { readonly kind: "env"; readonly variable: string }
	| { readonly kind: "command"; readonly command: string };

/** A credential a secrets file names, for one provider, and the file that holds it. */
export interface NamedCredential {
	readonly name: string;
	readonly provider: string;
	readonly type: "api_key";
	readonly value: CredentialValue;
	readonly file: string;
}

/** The credentials the secrets files hold, per-clone file first, each file in its own order, and what to warn about. */
export interface LoadedSecrets {
	readonly credentials: readonly NamedCredential[];
	readonly warnings: readonly string[];
}

// Whether the file could have been written by anyone but the user running Melian: another owner, or write access for
// the group or others. A command source runs on every review, so only the user's own file may hold one.
function userOwned(mode: number, uid: number): boolean {
	const self = process.getuid?.();
	return (self === undefined || uid === self) && (mode & 0o022) === 0;
}

// Why a command in the per-clone file must be refused, or `undefined` when git confirms it is the maintainer's own:
// tracked under no case of its name and ignored. Problem: on a case-insensitive filesystem a committed
// `MELIAN.SECRETS.YAML` opens as `melian.secrets.yaml`, and an exact-case lookup called it untracked. Solution: ask git
// case-insensitively, refuse the file whole when it is tracked, and refuse its commands whenever git cannot say.
async function cloneStanding(repoRoot: string, site: Site): Promise<string | undefined> {
	const name = melianPaths.secrets;
	const listed = await git(repoRoot, ["ls-files", "-z", "--", `:(icase)${name}`]);
	if (listed.code !== 0) return `git could not say whether it tracks ${name} (exit ${listed.code})`;
	const [tracked] = listed.stdout.split("\0").filter(Boolean);
	if (tracked !== undefined) {
		throw configError(
			"tracked",
			site,
			`git tracks ${tracked}, so it is the repository's, not yours; Melian reads no credential from it. Run git rm --cached ${tracked} and keep the file ignored`,
		);
	}
	const ignored = await git(repoRoot, ["check-ignore", "-q", "--", name]);
	if (ignored.code === 0) return undefined;
	return ignored.code === 1
		? `git does not ignore ${name}; add /${name} to .gitignore`
		: `git could not say whether it ignores ${name} (exit ${ignored.code})`;
}

async function readSecretsFile(path: string, repoRoot: string | undefined): Promise<LoadedSecrets> {
	const site: Site = { file: path, where: path };
	const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
		throw configError("unreadable", site, error.message, { cause: error });
	});
	if (info === undefined) return { credentials: [], warnings: [] };
	const standing = repoRoot === undefined ? undefined : await cloneStanding(repoRoot, site);
	if (info.size > maxConfigBytes) {
		throw configError("tooLarge", site, `${info.size} bytes; the limit is ${maxConfigBytes}`);
	}
	const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
		throw configError("unreadable", site, error.message, { cause: error });
	});
	const parsed = parseYaml(text, site, secretsFileSchema) as { credentials?: Record<string, Record<string, string>> };
	const owned = userOwned(info.mode, info.uid);
	const credentials = Object.entries(parsed.credentials ?? {}).map(([credential, entry]): NamedCredential => {
		const key = `credentials.${credential}`;
		const sources = (["key", "env", "command"] as const).filter((each) => entry[each] !== undefined);
		if (sources.length !== 1) {
			throw configError(
				"invalidValue",
				site,
				`"${key}" must take its value from exactly one of key, env, and command`,
				{ key },
			);
		}
		const [source] = sources as ["key" | "env" | "command"];
		if (source === "command" && standing !== undefined) {
			throw configError("notIgnored", site, `"${key}" runs a command, which Melian refuses here: ${standing}`, {
				key: `${key}.command`,
			});
		}
		if (source === "command" && !owned) {
			throw configError(
				"notUserOwned",
				site,
				`"${key}" runs a command, which Melian runs only from a file you own and no one else can write; chmod 600 ${path}`,
				{ key: `${key}.command` },
			);
		}
		const text = entry[source]!;
		const value: CredentialValue =
			source === "key"
				? { kind: "literal", key: text }
				: source === "env"
					? { kind: "env", variable: text }
					: { kind: "command", command: text };
		return { name: credential, provider: entry.provider!, type: "api_key", value, file: path };
	});
	const warnings =
		(info.mode & 0o077) === 0
			? []
			: [`${path} is readable by others (mode ${(info.mode & 0o777).toString(8)}); chmod 600 ${path}`];
	return { credentials, warnings };
}

/**
 * Reads the secrets files: `melian.secrets.yaml` beside the root `melian.yaml` of `repoRoot`, then `user`, the
 * user-level file, when given. Either may be absent. A credential takes its value from the file (`key`), an
 * environment variable (`env`), or a command's output (`command`), which only a file the user owns and no one else can
 * write may hold. Nothing is resolved here: no variable read and no command run. Throws {@link ConfigError}: `tracked`
 * for a per-clone file git tracks under any case of its name, since a head could supply it; `notIgnored` for a command
 * in a per-clone file git does not ignore, or when git cannot say; `notUserOwned` for a command in a file another user
 * could have written; and as `loadConfig` does for a file it cannot read or parse.
 */
export async function loadSecrets(repoRoot: string, user?: string): Promise<LoadedSecrets> {
	const clone = await readSecretsFile(join(repoRoot, melianPaths.secrets), repoRoot);
	const own = user === undefined ? { credentials: [], warnings: [] } : await readSecretsFile(user, undefined);
	return {
		credentials: [...clone.credentials, ...own.credentials],
		warnings: [...clone.warnings, ...own.warnings],
	};
}
