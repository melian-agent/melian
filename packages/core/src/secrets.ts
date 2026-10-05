import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
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

// Why the user-level file cannot be taken as the user's own, or `undefined`. Problem: O_NOFOLLOW guards only the final
// component, so `~/.config/melian` could be a symlink into a checkout, and a file a head wrote would read as the
// user's. Solution: its directory, the one below the configuration root, must not be a symlink, and the file's real
// path, whatever links lead to it, must lie outside the repository under review.
async function insideRepository(path: string, repoRoot: string): Promise<string | undefined> {
	const directory = dirname(path);
	if ((await lstat(directory).catch(() => undefined))?.isSymbolicLink()) {
		return `${directory} is a symlink; move the real directory there`;
	}
	const [real, root] = await Promise.all([realpath(path), realpath(repoRoot)]).catch(() => [undefined, undefined]);
	if (real === undefined || root === undefined) return `Melian could not resolve the real path of ${path}`;
	const inside = relative(root, real);
	const outside = inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
	return outside ? undefined : `${path} resolves to ${real}, inside the repository under review`;
}

// Refuses the per-clone file when git tracks it under any case of its name: a head could then supply it. Problem: on a
// case-insensitive filesystem a committed `MELIAN.SECRETS.YAML` opens as `melian.secrets.yaml`, and an exact-case
// lookup called it untracked. Solution: ask git case-insensitively. The file never holds a command, so a git that cannot
// answer leaves only literal and environment sources at stake, and the file is read.
async function refuseTracked(repoRoot: string, site: Site): Promise<void> {
	const listed = await git(repoRoot, ["ls-files", "-z", "--", `:(icase)${melianPaths.secrets}`]);
	const [tracked] = listed.code === 0 ? listed.stdout.split("\0").filter(Boolean) : [];
	if (tracked === undefined) return;
	throw configError(
		"tracked",
		site,
		`git tracks ${tracked}, so it is the repository's, not yours; Melian reads no credential from it. Run git rm --cached ${tracked} and keep the file ignored`,
	);
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

async function readSecretsFile(
	path: string,
	repoRoot: string | undefined,
	user: string | undefined,
	reviewed: string,
): Promise<LoadedSecrets> {
	const site: Site = { file: path, where: path };
	const read = await readOnce(path, site, repoRoot === undefined);
	if (read === undefined) return { credentials: [], warnings: [] };
	const { info, text } = read;
	if (repoRoot !== undefined) await refuseTracked(repoRoot, site);
	const parsed = parseYaml(text, site, secretsFileSchema, { redact: true }) as {
		credentials?: Record<string, Record<string, string>>;
	};
	const owner = await ownership(path, info);
	const inside = repoRoot === undefined ? await insideRepository(path, reviewed) : undefined;
	const credentials = Object.entries(parsed.credentials ?? {}).map(([credential, entry]): NamedCredential => {
		// A credential's name is a key, and a key may be a pasted secret, so errors name where it is, never what.
		const at = `the credential at ${locate(text, ["credentials", credential], true)}`;
		const sources = (["key", "env", "command"] as const).filter((each) => entry[each] !== undefined);
		if (sources.length !== 1) {
			throw configError("invalidValue", site, `${at} must take its value from exactly one of key, env, and command`);
		}
		const [source] = sources as ["key" | "env" | "command"];
		// Problem: a file in the working tree may be a head's, and no check on it holds under every umask: a patch applied
		// with umask 077 lands as the user's own file, mode 600, already ignored. Solution: a command runs only from the
		// user's own secrets file, outside every repository.
		if (source === "command" && repoRoot !== undefined) {
			throw configError(
				"cloneCommand",
				site,
				`${at} runs a command, which Melian runs only from your own secrets file, ${user ?? "$XDG_CONFIG_HOME/melian/secrets.yaml or ~/.config/melian/secrets.yaml"}; move it there, or use key or env here`,
			);
		}
		if (source === "command" && owner !== undefined) {
			throw configError(
				"notUserOwned",
				site,
				`${at} runs a command, which Melian runs only from a file you own and no one else can read, write, or replace: ${owner}`,
			);
		}
		if (source === "command" && inside !== undefined) {
			throw configError(
				"userFileInRepository",
				site,
				`${at} runs a command, which Melian runs only from your own secrets file, and that file must not lead into the checkout: ${inside}`,
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
 * environment variable (`env`), or a command's output (`command`). Only the user-level file may hold a command, and
 * only when the user owns it, its mode is 600, and no one else can replace it in its directory. Each file is opened once
 * and checked through that handle; the per-clone file is never read through a symlink. Nothing is resolved here: no
 * variable read and no command run. Throws {@link ConfigError}: `tracked` for a per-clone file git tracks under any case
 * of its name, since a head could supply it; `cloneCommand` for a command in the per-clone file; `notUserOwned` for a
 * command in a user-level file another user could have written; `userFileInRepository` for a command in a user-level
 * file whose directory is a symlink or whose real path lies inside `repoRoot`; and as `loadConfig` does for a file it cannot read or
 * parse. No error quotes the file: each names the file, its code, and a line and column, never a key or a value, and
 * none carries a `key`.
 */
export async function loadSecrets(repoRoot: string, user?: string): Promise<LoadedSecrets> {
	const clone = await readSecretsFile(join(repoRoot, melianPaths.secrets), repoRoot, user, repoRoot);
	const own =
		user === undefined ? { credentials: [], warnings: [] } : await readSecretsFile(user, undefined, user, repoRoot);
	return {
		credentials: [...clone.credentials, ...own.credentials],
		warnings: [...clone.warnings, ...own.warnings],
	};
}
