// Stores for issue #380, written to the decision's wording on branch docs-shared-record (rules 3 and 12), from the
// adapters in spike/record-370. Scripts, not product code. Node built-ins only.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.filter((key) => value[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error(`not a safe integer: ${value}`);
	return JSON.stringify(value);
}

export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
export const recordId = (envelope) => sha256(canonical(envelope));

const FIELDS = new Set(["v", "changeset", "revision", "kind", "key", "supersedes", "payload", "signer", "signature"]);
const NAME = /^[a-z0-9.-]+$/;

// Rule 3's shape: these fields and no other, names a path can hold, a canonical 64-byte signature.
export function checkEnvelope(record) {
	for (const field of Object.keys(record)) if (!FIELDS.has(field)) throw new Error(`unknown field ${field}`);
	if (record.v !== 1) throw new Error("v is not 1");
	for (const field of ["changeset", "kind"])
		if (typeof record[field] !== "string" || !NAME.test(record[field])) throw new Error(`bad ${field}`);
	if (typeof record.key !== "string") throw new Error("bad key");
	if (record.supersedes !== undefined && !(Array.isArray(record.supersedes) && record.supersedes.every((id) => /^[0-9a-f]{64}$/.test(id))))
		throw new Error("bad supersedes");
	if (record.signature !== undefined) {
		const bytes = Buffer.from(record.signature, "base64");
		if (bytes.length !== 64 || bytes.toString("base64") !== record.signature) throw new Error("bad signature");
	}
	canonical(record);
}

export const recordPath = (record) =>
	`changesets/${record.changeset}/${record.kind}/${sha256(record.key)}/${recordId(record)}.json`;
// The decision names no path for the cell. This one sits beside the kinds, where no kind can be named "cell.json".
export const cellPath = (changeset) => `changesets/${changeset}/cell.json`;
const KNOWN = /^changesets\/[a-z0-9.-]+\/(cell\.json|[a-z0-9.-]+\/[0-9a-f]{64}\/[0-9a-f]{64}\.json)$/;

export class UnknownFile extends Error {
	constructor(path) {
		super(`the store's branch holds a file the adapter does not know: ${JSON.stringify(path)}`);
		this.code = "unknownFile";
		this.path = path;
	}
}

export function git(cwd, args, { input, env, buffer, timeout } = {}) {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"git",
			args,
			{
				cwd,
				env: { ...process.env, GIT_CONFIG_COUNT: "0", GIT_CONFIG_GLOBAL: "/dev/null", ...env },
				maxBuffer: 256 * 1024 * 1024,
				...(timeout ? { timeout } : {}),
				...(buffer ? { encoding: "buffer" } : {}),
			},
			(error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr: String(stderr) })) : resolve(stdout)),
		);
		if (input !== undefined) child.stdin.end(input);
	});
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// The git adapter as rule 12 words it: plumbing in the clone's object database, a branch holding an unknown file
// refused whole, --force-with-lease on the fetched tip, a lost race retried after a random wait below a bound that
// doubles from 50 ms to a second, giving up after ten in a row, and a deadline on every fetch and push, a push stopped
// there counting as landed when the tip is the commit it sent. `landedWhen: "ancestor"` is the variant case 7 tests.
export class GitRecordStore {
	#dir;
	#remote;
	#ref;
	#tracking = "refs/spike/tip";
	options;
	stats = { pushes: 0, lostRaces: 0, deadlines: 0, landedAtDeadline: 0 };

	constructor(dir, remote, ref, options) {
		this.#dir = dir;
		this.#remote = remote;
		this.#ref = ref;
		this.options = { deadlineMs: 120_000, giveUpAfter: 10, landedWhen: "tip", ...options };
	}

	static async open({ remote, ref = "refs/heads/melian/state", ...options }) {
		const dir = await mkdtemp(join(tmpdir(), "spike-380-git-"));
		await git(dir, ["init", "-q", "--bare"]);
		return new GitRecordStore(dir, remote, ref, options);
	}

	async #fetch() {
		try {
			await git(this.#dir, ["fetch", "-q", "--no-tags", this.#remote, `+${this.#ref}:${this.#tracking}`], {
				timeout: this.options.deadlineMs,
			});
			return (await git(this.#dir, ["rev-parse", this.#tracking])).trim();
		} catch (error) {
			if (/couldn't find remote ref/.test(error.stderr ?? "")) return undefined;
			throw error;
		}
	}

	// Refused whole, before any byte is read in part or pushed over.
	async #checked(tip) {
		if (tip === undefined) return [];
		const entries = (await git(this.#dir, ["ls-tree", "-r", "-z", tip]))
			.split("\0")
			.filter(Boolean)
			.map((line) => {
				const [meta, path] = line.split("\t");
				const [mode, type, blob] = meta.split(" ");
				return { mode, type, blob, path };
			});
		for (const entry of entries)
			if (entry.type !== "blob" || entry.mode !== "100644" || !KNOWN.test(entry.path)) throw new UnknownFile(entry.path);
		return entries;
	}

	async #landed(tip, commit) {
		if (tip === commit) return true;
		if (this.options.landedWhen !== "ancestor" || tip === undefined) return false;
		try {
			await git(this.#dir, ["merge-base", "--is-ancestor", commit, tip]);
			return true;
		} catch {
			return false;
		}
	}

	// mutate(env, entries) returns { changed, result }.
	async #update(message, mutate) {
		let bound = 50;
		for (let lost = 0; ; ) {
			const tip = await this.#fetch();
			const entries = await this.#checked(tip);
			const scratch = await mkdtemp(join(tmpdir(), "spike-380-index-"));
			const env = { GIT_INDEX_FILE: join(scratch, "index") };
			try {
				await git(this.#dir, tip === undefined ? ["read-tree", "--empty"] : ["read-tree", tip], { env });
				const { changed, result } = await mutate(env, entries);
				if (!changed) return result;
				const tree = (await git(this.#dir, ["write-tree"], { env })).trim();
				const commit = (
					await git(
						this.#dir,
						["-c", "user.name=spike-380", "-c", "user.email=spike-380@invalid", "commit-tree", tree]
							.concat(tip === undefined ? [] : ["-p", tip])
							.concat(["-m", message]),
					)
				).trim();
				this.stats.pushes++;
				try {
					await git(this.#dir, ["push", "-q", `--force-with-lease=${this.#ref}:${tip ?? ""}`, this.#remote, `${commit}:${this.#ref}`], {
						timeout: this.options.deadlineMs,
					});
					return result;
				} catch (error) {
					if (error.killed) {
						this.stats.deadlines++;
						if (await this.#landed(await this.#fetch(), commit)) {
							this.stats.landedAtDeadline++;
							return result;
						}
					} else if (!/stale info|rejected|failed to push/.test(error.stderr ?? "")) throw error;
					this.stats.lostRaces++;
					if (++lost >= this.options.giveUpAfter) throw Object.assign(new Error(`gave up after ${lost} lost races`), { code: "gaveUp" });
					await sleep(Math.random() * bound);
					bound = Math.min(bound * 2, 1000);
				}
			} finally {
				await rm(scratch, { recursive: true, force: true });
			}
		}
	}

	async add(records) {
		for (const record of records) checkEnvelope(record);
		await this.#update(`add ${records.length}`, async (env, entries) => {
			const present = new Set(entries.map((entry) => entry.path));
			const lines = [];
			for (const record of records) {
				const path = recordPath(record);
				if (present.has(path)) continue;
				present.add(path);
				const blob = (await git(this.#dir, ["hash-object", "-w", "--stdin"], { input: canonical(record) })).trim();
				lines.push(`100644 ${blob}\t${path}\0`);
			}
			if (lines.length === 0) return { changed: false };
			await git(this.#dir, ["update-index", "-z", "--index-info"], { env, input: lines.join("") });
			return { changed: true };
		});
	}

	async list(changeset) {
		const tip = await this.#fetch();
		const blobs = (await this.#checked(tip)).filter(
			(entry) => entry.path.startsWith(`changesets/${changeset}/`) && entry.path !== cellPath(changeset),
		);
		if (blobs.length === 0) return [];
		const batch = await git(this.#dir, ["cat-file", "--batch"], { input: blobs.map(({ blob }) => `${blob}\n`).join(""), buffer: true });
		const records = [];
		let at = 0;
		for (let i = 0; i < blobs.length; i++) {
			const headerEnd = batch.indexOf(0x0a, at);
			const size = Number(batch.subarray(at, headerEnd).toString("utf8").split(" ")[2]);
			records.push(JSON.parse(batch.subarray(headerEnd + 1, headerEnd + 1 + size).toString("utf8")));
			at = headerEnd + 1 + size + 1;
		}
		return records;
	}

	async #cell(entries, changeset) {
		const entry = entries.find((each) => each.path === cellPath(changeset));
		if (entry === undefined) return {};
		return JSON.parse(await git(this.#dir, ["cat-file", "blob", entry.blob]));
	}

	async readCell(changeset) {
		return this.#cell(await this.#checked(await this.#fetch()), changeset);
	}

	// The version is opaque and fresh on every write, never a hash of the value.
	async writeCell(changeset, expectedVersion, value) {
		return this.#update(`cell ${changeset}`, async (env, entries) => {
			const { version } = await this.#cell(entries, changeset);
			if (version !== expectedVersion) return { changed: false, result: false };
			const bytes = JSON.stringify({ version: randomUUID(), value });
			const blob = (await git(this.#dir, ["hash-object", "-w", "--stdin"], { input: bytes })).trim();
			await git(this.#dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${cellPath(changeset)}`], { env });
			return { changed: true, result: true };
		});
	}

	async dispose(changeset) {
		await this.#update(`dispose ${changeset}`, async (env, entries) => {
			const paths = entries.map((entry) => entry.path).filter((path) => path.startsWith(`changesets/${changeset}/`));
			if (paths.length === 0) return { changed: false };
			const zero = "0".repeat(40);
			await git(this.#dir, ["update-index", "-z", "--index-info"], { env, input: paths.map((path) => `0 ${zero}\t${path}\0`).join("") });
			return { changed: true };
		});
	}

	async close() {
		await rm(this.#dir, { recursive: true, force: true });
	}
}

// The directory adapter: one file per record, written to a temporary name and renamed; the cell under a mkdir lock.
export class DirectoryRecordStore {
	root;

	constructor(root) {
		this.root = root;
	}

	static async open({ root }) {
		await mkdir(root, { recursive: true });
		return new DirectoryRecordStore(root);
	}

	async #writeAtomic(path, bytes) {
		const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, bytes);
		await rename(temporary, path);
	}

	async add(records) {
		for (const record of records) checkEnvelope(record);
		for (const record of records) {
			const path = join(this.root, recordPath(record));
			await mkdir(join(path, ".."), { recursive: true });
			try {
				await stat(path);
				continue;
			} catch {}
			await this.#writeAtomic(path, canonical(record));
		}
	}

	async list(changeset) {
		const records = [];
		const walk = async (dir) => {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch (error) {
				if (error.code === "ENOENT") return;
				throw error;
			}
			for (const entry of entries) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) await walk(path);
				else if (entry.name.endsWith(".json") && path !== join(this.root, cellPath(changeset)))
					records.push(JSON.parse(await readFile(path, "utf8")));
			}
		};
		await walk(join(this.root, "changesets", changeset));
		return records;
	}

	async readCell(changeset) {
		try {
			return JSON.parse(await readFile(join(this.root, cellPath(changeset)), "utf8"));
		} catch (error) {
			if (error.code === "ENOENT") return {};
			throw error;
		}
	}

	lockPath(changeset) {
		return join(this.root, "changesets", changeset, ".cell.lock");
	}

	async writeCell(changeset, expectedVersion, value, { lockWaitMs = 2000, dieInsideLock = false } = {}) {
		await mkdir(join(this.root, "changesets", changeset), { recursive: true });
		const lock = this.lockPath(changeset);
		const until = Date.now() + lockWaitMs;
		for (;;) {
			try {
				await mkdir(lock);
				break;
			} catch (error) {
				if (error.code !== "EEXIST") throw error;
				if (Date.now() > until) throw Object.assign(new Error("the cell's lock is held"), { code: "lockHeld" });
				await sleep(2);
			}
		}
		if (dieInsideLock) throw Object.assign(new Error("died inside the lock"), { code: "died" });
		try {
			const { version } = await this.readCell(changeset);
			if (version !== expectedVersion) return false;
			await this.#writeAtomic(join(this.root, cellPath(changeset)), JSON.stringify({ version: randomUUID(), value }));
			return true;
		} finally {
			await rmdir(lock);
		}
	}

	async dispose(changeset) {
		await rm(join(this.root, "changesets", changeset), { recursive: true, force: true });
	}

	async close() {}
}

// A bare repository on disk standing in for the remote, with hooks that wait as long as a file in it says.
export async function localRemote() {
	const dir = await mkdtemp(join(tmpdir(), "spike-380-remote-"));
	await git(dir, ["init", "-q", "--bare"]);
	for (const hook of ["pre-receive", "post-receive"]) {
		const path = join(dir, "hooks", hook);
		await writeFile(path, `#!/bin/sh\ncat >/dev/null\nd=$(cat "${join(dir, hook)}.delay" 2>/dev/null || echo 0)\nsleep "$d"\n`, { mode: 0o755 });
	}
	return {
		url: `file://${dir}`,
		dir,
		delay: (hook, seconds) => writeFile(join(dir, `${hook}.delay`), String(seconds)),
		tip: async (ref = "refs/heads/melian/state") => (await git(dir, ["rev-parse", ref]).catch(() => "")).trim() || undefined,
		close: () => rm(dir, { recursive: true, force: true }),
	};
}
