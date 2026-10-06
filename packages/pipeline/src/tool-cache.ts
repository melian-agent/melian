import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { ToolManifest, type ToolPin } from "@melian-agent/core";

const archiveLimit = 128 * 1024 * 1024;
const expandedLimit = 256 * 1024 * 1024;
const binaryLimit = 96 * 1024 * 1024;

/** A pin could not be downloaded, verified, or safely extracted. */
export class ToolCacheError extends Error {
	readonly code: "toolMissing" | "toolFailed" | "invalidOutput" | "outputTooLarge";
	constructor(code: ToolCacheError["code"], message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ToolCacheError";
		this.code = code;
	}
}

/** The binary and archive hashes recorded beside a materialised tool. */
export type ToolBinaryReceipt = { format_version: 1; archive: string; binary: string };

/** A download seam. Tests return a local archive without contacting a release host. */
export type ToolFetch = (url: string, options: { signal: AbortSignal }) => Promise<Response>;

/** A cache of verified binaries, shared with the graph cache's root. */
export class ToolCache {
	readonly root: string;
	readonly #fetch: ToolFetch;
	private constructor(root: string, download: ToolFetch) {
		this.root = root;
		this.#fetch = download;
	}

	/** Opens a cache without fetching anything. */
	static async open(root: string, options: { fetch?: ToolFetch } = {}): Promise<ToolCache> {
		root = resolve(root);
		return new ToolCache(root, options.fetch ?? fetch);
	}

	#pin(tool: ToolPin, platform: string): { directory: string; sha256: string; url: string; binary?: string } {
		const { name, ...fields } = tool;
		const manifest = ToolManifest.parse(JSON.stringify({ format_version: 1, tools: { [name]: fields }, misses: [] }));
		const problems = manifest.check(Date.now(), 2);
		if (problems.length) throw new ToolCacheError("toolFailed", problems.join("; "));
		const artifact = manifest.artifact(name, platform);
		return { ...artifact, directory: join(this.root, "tools", name, tool.version, platform, artifact.sha256) };
	}

	/** Checks readiness without downloading or running the binary. */
	async readiness(tool: ToolPin, platform: string): Promise<"verified" | "not-fetched" | "mismatch"> {
		const pin = this.#pin(tool, platform);
		if (await this.#cached(pin.directory, pin.sha256, pin.binary)) return "verified";
		try {
			await lstat(pin.directory);
			return "mismatch";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "not-fetched";
			throw error;
		}
	}

	/** Returns the extracted executable's digest after re-verifying the cached pin. */
	async digest(tool: ToolPin, platform: string): Promise<string> {
		const path = await this.materialise(tool, platform);
		return createHash("sha256")
			.update(await readFile(path))
			.digest("hex");
	}

	/** Returns a verified executable, repairing a missing or swapped entry from the pinned download. */
	async materialise(tool: ToolPin, platform: string): Promise<string> {
		const pin = this.#pin(tool, platform);
		const cached = await this.#cached(pin.directory, pin.sha256, pin.binary);
		if (cached) return cached;
		await mkdir(dirname(pin.directory), { recursive: true });
		const temporary = await mkdtemp(join(dirname(pin.directory), ".fetch-"));
		try {
			const archive = join(temporary, "archive");
			await this.#download(pin.url, archive, pin.sha256);
			const bytes = await readFile(archive);
			const binary = pin.binary === undefined ? bytes : this.#extract(bytes, pin.binary);
			if (binary.length > binaryLimit) throw new ToolCacheError("outputTooLarge", "Tool binary exceeds 96 MiB");
			await writeFile(join(temporary, "binary"), binary, { mode: 0o755, flag: "wx" });
			await chmod(join(temporary, "binary"), 0o755);
			const receipt: ToolBinaryReceipt = {
				format_version: 1,
				archive: pin.sha256,
				binary: createHash("sha256").update(binary).digest("hex"),
			};
			await writeFile(join(temporary, "receipt.json"), JSON.stringify(receipt), { flag: "wx" });
			const winner = await this.#cached(pin.directory, pin.sha256, pin.binary);
			if (winner) return winner;
			await mkdir(pin.directory, { recursive: true });
			const entry = join(pin.directory, `entry-${crypto.randomUUID()}`);
			await rename(temporary, entry);
			if (!(await this.#verified(entry, pin.sha256, pin.binary)))
				throw new ToolCacheError("invalidOutput", "Materialised tool failed verification");
			return join(entry, "binary");
		} catch (cause) {
			if (cause instanceof ToolCacheError) throw cause;
			throw new ToolCacheError(
				"toolFailed",
				`Could not materialise ${tool.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
				{ cause },
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}

	async #cached(directory: string, archive: string, wanted?: string): Promise<string | undefined> {
		if (await this.#verified(directory, archive, wanted)) return join(directory, "binary");
		try {
			if (!(await lstat(directory)).isDirectory()) return undefined;
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				if (!entry.isDirectory() || !entry.name.startsWith("entry-")) continue;
				const path = join(directory, entry.name);
				if (await this.#verified(path, archive, wanted)) return join(path, "binary");
			}
		} catch {
			return undefined;
		}
		return undefined;
	}

	async #verified(directory: string, archive: string, wanted?: string): Promise<boolean> {
		try {
			if (!(await lstat(directory)).isDirectory()) return false;
			const receiptPath = join(directory, "receipt.json");
			const info = await lstat(receiptPath);
			if (!info.isFile() || info.size > 4096) return false;
			const receipt: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
			if (typeof receipt !== "object" || receipt === null) return false;
			const stored = receipt as Partial<ToolBinaryReceipt>;
			if (stored.format_version !== 1 || stored.archive !== archive || !/^[a-f0-9]{64}$/.test(stored.binary ?? ""))
				return false;
			const download = await open(join(directory, "archive"), constants.O_RDONLY | constants.O_NOFOLLOW);
			let bytes: Buffer;
			try {
				const stat = await download.stat();
				if (!stat.isFile() || stat.size > archiveLimit) return false;
				bytes = await download.readFile();
			} finally {
				await download.close();
			}
			if (createHash("sha256").update(bytes).digest("hex") !== archive) return false;
			const extracted = wanted === undefined ? bytes : this.#extract(bytes, wanted);
			if (extracted.length > binaryLimit) return false;
			const expected = createHash("sha256").update(extracted).digest("hex");
			if (stored.binary !== expected) return false;
			const binary = await open(join(directory, "binary"), constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const stat = await binary.stat();
				if (!stat.isFile() || stat.size > binaryLimit || !(stat.mode & 0o111)) return false;
				const hash = createHash("sha256");
				for await (const chunk of binary.createReadStream({ autoClose: false })) hash.update(chunk);
				return hash.digest("hex") === expected;
			} finally {
				await binary.close();
			}
		} catch {
			return false;
		}
	}

	async #download(url: string, target: string, expected: string): Promise<void> {
		const response = await this.#fetch(url, { signal: AbortSignal.timeout(120_000) });
		if (!response.ok || !response.body)
			throw new ToolCacheError("toolFailed", `Download failed: HTTP ${response.status}`);
		const file = await open(target, "wx", 0o600);
		const hash = createHash("sha256");
		let size = 0;
		try {
			for await (const chunk of response.body) {
				size += chunk.byteLength;
				if (size > archiveLimit) throw new ToolCacheError("outputTooLarge", "Tool archive exceeds 128 MiB");
				hash.update(chunk);
				await file.writeFile(chunk);
			}
		} finally {
			await file.close();
		}
		if (hash.digest("hex") !== expected)
			throw new ToolCacheError("invalidOutput", "Tool archive SHA-256 mismatch; nothing extracted");
	}

	#extract(compressed: Buffer, wanted: string): Buffer {
		const tar = gunzipSync(compressed, { maxOutputLength: expandedLimit });
		let found: Buffer | undefined;
		let ended = false;
		for (let offset = 0; offset + 512 <= tar.length; ) {
			const header = tar.subarray(offset, offset + 512);
			if (header.every((byte) => byte === 0)) {
				ended = true;
				break;
			}
			const string = (start: number, length: number) =>
				header
					.subarray(start, start + length)
					.toString("utf8")
					.split("\0")[0]!;
			for (const [start, length] of [
				[0, 100],
				[345, 155],
			]) {
				const field = header.subarray(start, start + length);
				const end = field.indexOf(0);
				if (end >= 0 && field.subarray(end).some((byte) => byte !== 0))
					throw new ToolCacheError("invalidOutput", "Embedded NUL in tar name");
			}
			const name = [string(345, 155), string(0, 100)].filter(Boolean).join("/");
			const kind = string(156, 1);
			const sizeText = string(124, 12).trim();
			const checksum = Number.parseInt(string(148, 8).trim(), 8);
			const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
			if (checksum !== sum || !/^[0-7]+$/.test(sizeText))
				throw new ToolCacheError("invalidOutput", "Invalid tar header");
			const size = Number.parseInt(sizeText, 8);
			if (
				/^[\\/]/.test(name) ||
				name.includes("\\") ||
				name.split("/").includes("..") ||
				!["", "0", "5"].includes(kind)
			)
				throw new ToolCacheError("invalidOutput", `Unsafe tar entry: ${name}`);
			if (!Number.isSafeInteger(size) || size > expandedLimit || offset + 512 + size > tar.length)
				throw new ToolCacheError("invalidOutput", "Truncated tar entry");
			if (name === wanted) {
				if (found || kind === "5" || size > binaryLimit)
					throw new ToolCacheError("invalidOutput", "Invalid or duplicate binary entry");
				found = tar.subarray(offset + 512, offset + 512 + size);
			}
			offset += 512 + Math.ceil(size / 512) * 512;
		}
		if (!found || !ended) throw new ToolCacheError("invalidOutput", "Pinned binary absent or tar archive incomplete");
		return found;
	}
}
