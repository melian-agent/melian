import { constants, type Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import Type from "typebox";
import { configError, locate, maxConfigBytes, parseYaml, type Site } from "./config.ts";
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

// Why a command source in the file must be refused, or `undefined` when only the user running Melian could have
// written it: theirs, readable and writable by no one else, in a directory no one else can replace it in. A command
// runs on every review, so a file anyone else could have written, or swapped, must not hold one. git writes the files
// it checks out readable by others, so the mode also rules out a file a head put in the working tree.
async function ownership(path: string, info: Stats): Promise<string | undefined> {
	const self = process.getuid?.();
	if (self !== undefined && info.uid !== self) return `another user owns ${path}; chown it to yourself`;
	if ((info.mode & 0o077) !== 0) return `${path} has mode ${(info.mode & 0o777).toString(8)}; chmod 600 ${path}`;
	const directory = dirname(path);
	const parent = await stat(directory).catch(() => undefined);
	if (parent === undefined) return `Melian could not read ${directory}`;
	// The sticky bit, which Node's fs.constants does not name: only a file's owner may then rename or remove it.
	const shared = (parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0;
	return shared ? `others can replace files in ${directory}; chmod go-w ${directory}` : undefined;
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

// The file's metadata and text, from one open, so what was checked is what was read: a path checked and then opened
// again could be swapped between the two. The per-clone file is never followed through a symlink; a user's own file
// in their configuration directory may be, as dotfiles often are. A FIFO opens without blocking and is refused.
async function readOnce(path: string, site: Site, follow: boolean): Promise<{ info: Stats; text: string } | undefined> {
	const flags = constants.O_RDONLY | constants.O_NONBLOCK | (follow ? 0 : constants.O_NOFOLLOW);
	const handle = await open(path, flags).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
		if (error.code === "ELOOP") throw configError("symlink", site, "is a symlink; Melian reads it only as a file");
		throw configError("unreadable", site, error.message, { cause: error });
	});
	if (handle === undefined) return undefined;
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw configError("unreadable", site, "is not a regular file");
		if (info.size > maxConfigBytes) {
			throw configError("tooLarge", site, `${info.size} bytes; the limit is ${maxConfigBytes}`);
		}
		const text = await handle.readFile("utf8").catch((error: NodeJS.ErrnoException) => {
			throw configError("unreadable", site, error.message, { cause: error });
		});
		return { info, text };
	} finally {
		await handle.close();
	}
}

async function readSecretsFile(path: string, repoRoot: string | undefined): Promise<LoadedSecrets> {
	const site: Site = { file: path, where: path };
	const read = await readOnce(path, site, repoRoot === undefined);
	if (read === undefined) return { credentials: [], warnings: [] };
	const { info, text } = read;
	const standing = repoRoot === undefined ? undefined : await cloneStanding(repoRoot, site);
	const parsed = parseYaml(text, site, secretsFileSchema, { redact: true }) as {
		credentials?: Record<string, Record<string, string>>;
	};
	const owner = await ownership(path, info);
	const credentials = Object.entries(parsed.credentials ?? {}).map(([credential, entry]): NamedCredential => {
		// A credential's name is a key, and a key may be a pasted secret, so errors name where it is, never what.
		const at = `the credential at ${locate(text, ["credentials", credential], true)}`;
		const sources = (["key", "env", "command"] as const).filter((each) => entry[each] !== undefined);
		if (sources.length !== 1) {
			throw configError("invalidValue", site, `${at} must take its value from exactly one of key, env, and command`);
		}
		const [source] = sources as ["key" | "env" | "command"];
		if (source === "command" && standing !== undefined) {
			throw configError("notIgnored", site, `${at} runs a command, which Melian refuses here: ${standing}`);
		}
		if (source === "command" && owner !== undefined) {
			throw configError(
				"notUserOwned",
				site,
				`${at} runs a command, which Melian runs only from a file you own and no one else can read, write, or replace: ${owner}`,
			);
		}
		const given = entry[source]!;
		const value: CredentialValue =
			source === "key"
				? { kind: "literal", key: given }
				: source === "env"
					? { kind: "env", variable: given }
					: { kind: "command", command: given };
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
 * environment variable (`env`), or a command's output (`command`), which only a file the user owns, of mode 600, in a
 * directory no one else can replace it in, may hold. Each file is opened once and checked through that handle; the
 * per-clone file is never read through a symlink. Nothing is resolved here: no variable read and no command run. Throws {@link ConfigError}: `tracked`
 * for a per-clone file git tracks under any case of its name, since a head could supply it; `notIgnored` for a command
 * in a per-clone file git does not ignore, or when git cannot say; `notUserOwned` for a command in a file another user
 * could have written; and as `loadConfig` does for a file it cannot read or parse. No error quotes the file: each
 * names the file, its code, and a line and column, never a key or a value, and none carries a `key`.
 */
export async function loadSecrets(repoRoot: string, user?: string): Promise<LoadedSecrets> {
	const clone = await readSecretsFile(join(repoRoot, melianPaths.secrets), repoRoot);
	const own = user === undefined ? { credentials: [], warnings: [] } : await readSecretsFile(user, undefined);
	return {
		credentials: [...clone.credentials, ...own.credentials],
		warnings: [...clone.warnings, ...own.warnings],
	};
}
