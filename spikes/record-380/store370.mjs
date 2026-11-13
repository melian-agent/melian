// Spike for issue #370: the RecordStore port from issue #368, with a git adapter and a directory adapter.
// Scripts, not product code. Node built-ins only.
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.filter((key) => value[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

export const recordId = (envelope) => sha256(canonical(envelope));

// A throwaway Ed25519 key, generated in the session and never written to disk.
export class Signer {
	constructor() {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
		this.id = createHash("sha256").update(raw).digest("hex").slice(0, 16);
		this.privateKey = privateKey;
	}

	record(changeset, kind, key, payload) {
		const unsigned = { v: 1, changeset, kind, key, payload, signer: this.id };
		const signature = sign(null, Buffer.from(canonical(unsigned), "utf8"), this.privateKey).toString("base64");
		return { ...unsigned, signature };
	}
}

const recordPath = (record) =>
	`changesets/${record.changeset}/${record.kind}/${sha256(record.key)}/${recordId(record)}.json`;
const cellPath = (changeset) => `changesets/${changeset}/cell.json`;

function git(cwd, args, { input, env, buffer } = {}) {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"git",
			args,
			{
				cwd,
				env: { ...process.env, ...env },
				maxBuffer: 256 * 1024 * 1024,
				...(buffer ? { encoding: "buffer" } : {}),
			},
			(error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stdout)),
		);
		if (input !== undefined) child.stdin.end(input);
	});
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// The record store on one ref of a git remote. Every write rebuilds a tree from the fetched tip in a throwaway
// index, commits it on top, and pushes with a lease on that tip; a rejected push fetches and tries again.
export class GitRecordStore {
	#dir;
	#remote;
	#ref;
	#tracking = "refs/spike/tip";
	#attempts = 0;

	constructor(dir, remote, ref) {
		this.#dir = dir;
		this.#remote = remote;
		this.#ref = ref;
	}

	static async open({ remote, ref }) {
		const dir = await mkdtemp(join(tmpdir(), "spike-370-git-"));
		await git(dir, ["init", "-q", "--bare"]);
		return new GitRecordStore(dir, remote, ref);
	}

	get pushAttempts() {
		return this.#attempts;
	}

	async #fetch() {
		try {
			await git(this.#dir, ["fetch", "-q", "--no-tags", this.#remote, `+${this.#ref}:${this.#tracking}`]);
			return (await git(this.#dir, ["rev-parse", this.#tracking])).trim();
		} catch (error) {
			if (/couldn't find remote ref/.test(error.stderr ?? "")) return undefined;
			throw error;
		}
	}

	async #blobAt(tip, path) {
		if (tip === undefined) return undefined;
		const line = (await git(this.#dir, ["ls-tree", tip, "--", path])).trim();
		return line === "" ? undefined : line.split(/\s+/)[2];
	}

	// mutate(index env, tip) returns { changed, result }. Unchanged trees push nothing.
	async #update(message, mutate) {
		for (let attempt = 1; ; attempt++) {
			const tip = await this.#fetch();
			const scratch = await mkdtemp(join(tmpdir(), "spike-370-index-"));
			const env = { GIT_INDEX_FILE: join(scratch, "index") };
			try {
				await git(this.#dir, tip === undefined ? ["read-tree", "--empty"] : ["read-tree", tip], { env });
				const { changed, result } = await mutate(env, tip);
				if (!changed) return result;
				const tree = (await git(this.#dir, ["write-tree"], { env })).trim();
				const commit = (
					await git(
						this.#dir,
						["-c", "user.name=spike-370", "-c", "user.email=spike-370@invalid", "commit-tree", tree]
							.concat(tip === undefined ? [] : ["-p", tip])
							.concat(["-m", message]),
					)
				).trim();
				this.#attempts++;
				try {
					await git(this.#dir, [
						"push",
						"-q",
						`--force-with-lease=${this.#ref}:${tip ?? ""}`,
						this.#remote,
						`${commit}:${this.#ref}`,
					]);
					return result;
				} catch (error) {
					if (attempt >= 60) throw error;
					await sleep(50 + Math.random() * 250 * Math.min(attempt, 8));
				}
			} finally {
				await rm(scratch, { recursive: true, force: true });
			}
		}
	}

	async add(record) {
		const path = recordPath(record);
		const bytes = canonical(record);
		await this.#update(`add ${path}`, async (env) => {
			const existing = (await git(this.#dir, ["ls-files", "-s", "--", path], { env })).trim();
			if (existing !== "") return { changed: false };
			const blob = (await git(this.#dir, ["hash-object", "-w", "--stdin"], { input: bytes })).trim();
			await git(this.#dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
			return { changed: true };
		});
	}

	async list(changeset) {
		const tip = await this.#fetch();
		if (tip === undefined) return [];
		const out = await git(this.#dir, ["ls-tree", "-r", "-z", tip, "--", `changesets/${changeset}/`]);
		const blobs = out
			.split("\0")
			.filter(Boolean)
			.map((line) => {
				const [meta, path] = line.split("\t");
				return { blob: meta.split(" ")[2], path };
			})
			.filter(({ path }) => path !== cellPath(changeset));
		if (blobs.length === 0) return [];
		const batch = await git(this.#dir, ["cat-file", "--batch"], {
			input: blobs.map(({ blob }) => `${blob}\n`).join(""),
			buffer: true,
		});
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

	async readCell(changeset) {
		const tip = await this.#fetch();
		const blob = await this.#blobAt(tip, cellPath(changeset));
		if (blob === undefined) return {};
		return { value: await git(this.#dir, ["cat-file", "blob", blob]), version: blob };
	}

	async writeCell(changeset, expectedVersion, value) {
		const path = cellPath(changeset);
		return this.#update(`cell ${changeset}`, async (env, tip) => {
			const current = await this.#blobAt(tip, path);
			if (current !== expectedVersion) return { changed: false, result: false };
			// The version is the blob's ID, so a value the cell already holds would keep its version: refuse it, since a
			// writer that "won" without changing the version could not tell its write from a rival's.
			const blob = (await git(this.#dir, ["hash-object", "-w", "--stdin"], { input: value })).trim();
			if (blob === current) return { changed: false, result: false };
			await git(this.#dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
			return { changed: true, result: true };
		});
	}

	async dispose(changeset) {
		await this.#update(`dispose ${changeset}`, async (env) => {
			const paths = (await git(this.#dir, ["ls-files", "-z", "--", `changesets/${changeset}/`], { env }))
				.split("\0")
				.filter(Boolean);
			if (paths.length === 0) return { changed: false };
			// --force-remove needs a work tree; a mode-0 --index-info line removes the entry from a bare repository's index.
			const zero = "0".repeat(40);
			await git(this.#dir, ["update-index", "-z", "--index-info"], {
				env,
				input: paths.map((path) => `0 ${zero}\t${path}\0`).join(""),
			});
			return { changed: true };
		});
	}

	async close() {
		await rm(this.#dir, { recursive: true, force: true });
	}
}

// The record store in a plain directory: one file per record, written to a temporary name and renamed, and the
// cell under a mkdir lock, since a rename alone cannot compare before it swaps.
export class DirectoryRecordStore {
	#root;

	constructor(root) {
		this.#root = root;
	}

	static async open({ root }) {
		await mkdir(root, { recursive: true });
		return new DirectoryRecordStore(root);
	}

	async #writeAtomic(path, bytes) {
		const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
		await writeFile(temporary, bytes);
		await rename(temporary, path);
	}

	async add(record) {
		const path = join(this.#root, recordPath(record));
		await mkdir(join(path, ".."), { recursive: true });
		try {
			await stat(path);
			return;
		} catch {}
		await this.#writeAtomic(path, canonical(record));
	}

	async list(changeset) {
		const root = join(this.#root, "changesets", changeset);
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
				else if (entry.name.endsWith(".json") && path !== join(this.#root, cellPath(changeset)))
					records.push(JSON.parse(await readFile(path, "utf8")));
			}
		};
		await walk(root);
		return records;
	}

	async readCell(changeset) {
		try {
			const value = await readFile(join(this.#root, cellPath(changeset)), "utf8");
			return { value, version: sha256(value) };
		} catch (error) {
			if (error.code === "ENOENT") return {};
			throw error;
		}
	}

	async writeCell(changeset, expectedVersion, value) {
		const dir = join(this.#root, "changesets", changeset);
		await mkdir(dir, { recursive: true });
		const lock = join(dir, ".cell.lock");
		for (let attempt = 0; ; attempt++) {
			try {
				await mkdir(lock);
				break;
			} catch (error) {
				if (error.code !== "EEXIST" || attempt > 2000) throw error;
				await sleep(2);
			}
		}
		try {
			const { version } = await this.readCell(changeset);
			if (version !== expectedVersion || sha256(value) === version) return false;
			await this.#writeAtomic(join(this.#root, cellPath(changeset)), value);
			return true;
		} finally {
			await rmdir(lock);
		}
	}

	async dispose(changeset) {
		await rm(join(this.#root, "changesets", changeset), { recursive: true, force: true });
	}

	async close() {}
}

export async function openStore(kind, options) {
	return kind === "git" ? GitRecordStore.open(options) : DirectoryRecordStore.open(options);
}
