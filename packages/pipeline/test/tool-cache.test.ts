import { createHash } from "node:crypto";
import type * as fs from "node:fs/promises";
import {
	chmod,
	type FileHandle,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolCache, type ToolFetch } from "../src/tool-cache.ts";
import { testTool, toolArchive } from "./fixtures/tool-archive.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof fs>();
	return {
		...original,
		rm: vi.fn(original.rm),
		open: vi.fn(original.open),
		rename: vi.fn(original.rename),
		lstat: vi.fn(original.lstat),
	};
});

let root: string;
beforeEach(async () => {
	vi.clearAllMocks();
	root = await mkdtemp(join(tmpdir(), "melian-tools-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

it.each([new Error("local download refused"), "local download refused"])(
	"preserves a download error and removes its partial directory: %s",
	async (failure) => {
		const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
		const cache = await ToolCache.open(root, {
			fetch: async () => {
				throw failure;
			},
		});
		await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({
			code: "toolFailed",
			message: "Could not materialise enola: local download refused",
			cause: failure,
		});
		expect((await readdir(root, { recursive: true })).filter((path) => path.includes(".fetch-"))).toEqual([]);
	},
);

it("closes download and verification handles after a binary stat refusal", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const original = await vi.importActual<typeof fs>("node:fs/promises");
	const handles: FileHandle[] = [];
	vi.mocked(open).mockImplementation(async (...args) => {
		const handle = await original.open(...args);
		vi.spyOn(handle, "close");
		if (String(args[0]).endsWith("/binary")) {
			const stat = await handle.stat();
			vi.spyOn(stat, "isFile").mockReturnValue(false);
			vi.spyOn(handle, "stat").mockResolvedValue(stat);
		}
		handles.push(handle);
		return handle;
	});
	try {
		const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
		await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({
			code: "invalidOutput",
			message: "Materialised tool failed verification",
		});
		expect(handles).toHaveLength(3);
		for (const handle of handles) expect(handle.close).toHaveBeenCalledOnce();
	} finally {
		for (const handle of handles) await handle.close();
		vi.mocked(open).mockImplementation(original.open);
	}
});

describe("ToolCache", () => {
	it("checks a missing cache without creating directories", async () => {
		const directory = join(root, "absent");
		const bytes = toolArchive([{ name: "enola", text: "binary" }]);
		const download = vi.fn(async () => new Response(bytes));
		const cache = await ToolCache.open(directory, { fetch: download });
		expect(await cache.readiness(testTool(bytes), "darwin-arm64")).toBe("not-fetched");
		await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
		expect(download).not.toHaveBeenCalled();
	});

	it("extracts only the pinned binary and verifies every cached use, repairing a swap", async () => {
		const script = "#!/bin/sh\nprintf '%s' '{\"runs\":[{\"results\":[]}]}'\n";
		const bytes = toolArchive([
			{ name: "enola", text: script },
			{ name: "LICENSE", text: "licence" },
		]);
		await writeFile(join(root, "fixture.tar.gz"), bytes);
		const download = vi.fn(async () => new Response(await readFile(join(root, "fixture.tar.gz"))));
		const cache = await ToolCache.open(root, { fetch: download });
		const tool = testTool(bytes);
		expect(await cache.readiness(tool, "darwin-arm64")).toBe("not-fetched");
		const binary = await cache.materialise(tool, "darwin-arm64");
		expect(await readFile(binary, "utf8")).toBe(script);
		expect(await cache.readiness(tool, "darwin-arm64")).toBe("verified");
		await cache.materialise(tool, "darwin-arm64");
		expect(download).toHaveBeenCalledTimes(1);
		await writeFile(binary, "swapped");
		expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
		const repaired = await cache.materialise(tool, "darwin-arm64");
		expect(download).toHaveBeenCalledTimes(2);
		expect(await readFile(repaired, "utf8")).toBe(script);
	});

	it("refuses a forged executable and sidecar without trusting their matching hashes", async () => {
		const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
		const download = vi.fn(async () => new Response(bytes));
		const cache = await ToolCache.open(root, { fetch: download });
		const tool = testTool(bytes);
		const binary = await cache.materialise(tool, "darwin-arm64");
		await writeFile(binary, "forged");
		await writeFile(
			join(dirname(binary), "receipt.json"),
			JSON.stringify({
				format_version: 1,
				archive: tool.platforms["darwin-arm64"]!.sha256,
				binary: createHash("sha256").update("forged").digest("hex"),
			}),
		);
		expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
		const repaired = await cache.materialise(tool, "darwin-arm64");
		expect(await readFile(repaired, "utf8")).toBe("trusted");
		expect(download).toHaveBeenCalledTimes(2);
		await writeFile(join(dirname(repaired), "archive"), "forged archive");
		expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
	});

	it("publishes concurrent downloads without removing a returned executable", async () => {
		const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
		let release!: () => void;
		const barrier = new Promise<void>((done) => {
			release = done;
		});
		const download = vi.fn(async () => {
			if (download.mock.calls.length === 2) release();
			await barrier;
			return new Response(bytes);
		});
		const first = await ToolCache.open(root, { fetch: download });
		const second = await ToolCache.open(root, { fetch: download });
		const tool = testTool(bytes);
		const binaries = await Promise.all([
			first.materialise(tool, "darwin-arm64"),
			second.materialise(tool, "darwin-arm64"),
		]);
		for (const binary of binaries) expect(await readFile(binary, "utf8")).toBe("trusted");
		const removals = vi.mocked(rm).mock.calls.filter(([path]) => !String(path).includes(".fetch-"));
		expect(removals).toEqual([]);
		await writeFile(binaries[0]!, "corrupt");
		const repaired = await first.materialise(tool, "darwin-arm64");
		expect(await readFile(repaired, "utf8")).toBe("trusted");
		expect(vi.mocked(rm).mock.calls.filter(([path]) => !String(path).includes(".fetch-"))).toEqual([]);
	});

	it("refuses a wrong digest before attempting extraction, and fetch errors", async () => {
		const bytes = toolArchive([{ name: "enola", text: "binary" }]);
		const cache = await ToolCache.open(root, { fetch: async () => new Response("not even gzip") });
		await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({
			code: "invalidOutput",
			message: expect.stringContaining("SHA-256 mismatch"),
		});
		const broken = await ToolCache.open(root, {
			fetch: async () => {
				throw new Error("offline");
			},
		});
		await expect(broken.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({ code: "toolFailed" });
	});

	it.each([{ name: "enola", kind: "2" }, { name: "enola", kind: "1" }, { name: "../enola" }, { name: "/enola" }])(
		"refuses dangerous archive entries %j",
		async (entry) => {
			const bytes = toolArchive([
				{ ...entry, text: "outside" },
				{ name: "enola", text: "trusted" },
			]);
			const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
			await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({
				code: "invalidOutput",
				message: expect.stringContaining("Unsafe tar entry"),
			});
		},
	);

	it("refuses a symlink to a byte-identical binary", async () => {
		const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
		const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
		const tool = testTool(bytes);
		const binary = await cache.materialise(tool, "darwin-arm64");
		const target = join(root, "identical");
		await writeFile(target, "trusted", { mode: 0o755 });
		await rm(binary);
		await symlink(target, binary);
		expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
	});

	it.each(["duplicate", "unterminated"])("refuses a %s binary archive", async (kind) => {
		let bytes = toolArchive([
			{ name: "enola", text: "trusted" },
			...(kind === "duplicate" ? [{ name: "enola", text: "trusted" }] : []),
		]);
		if (kind === "unterminated") bytes = gzipSync(gunzipSync(bytes).subarray(0, -1024));
		const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
		await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({ code: "invalidOutput" });
	});

	it("refuses bytes hidden after a tar name terminator", async () => {
		const bytes = toolArchive([{ name: "enola\0../../x", text: "trusted" }]);
		const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
		await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({
			code: "invalidOutput",
			message: expect.stringContaining("NUL"),
		});
	});

	it("refuses absent binary, unsupported platform, and a young release", async () => {
		const bytes = toolArchive([{ name: "LICENSE", text: "licence" }]);
		const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
		const tool = testTool(bytes);
		await expect(cache.materialise(tool, "darwin-arm64")).rejects.toMatchObject({ code: "invalidOutput" });
		await expect(cache.materialise(tool, "windows-amd64")).rejects.toMatchObject({ code: "toolMissing" });
		await expect(
			cache.materialise({ ...tool, published: new Date().toISOString() }, "darwin-arm64"),
		).rejects.toMatchObject({ code: "toolFailed" });
	});

	it("supports a standalone executable with no archive path", async () => {
		const bytes = Buffer.from("#!/bin/sh\nexit 0\n");
		const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
		const tool = testTool(bytes);
		delete tool.platforms["darwin-arm64"]!.binary;
		expect(await readFile(await cache.materialise(tool, "darwin-arm64"))).toEqual(bytes);
	});
});

it("reads the configured quarantine window rather than assuming two days", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const tool = { ...testTool(bytes), published: new Date(Date.now() - 3 * 86_400_000).toISOString() };
	const download = vi.fn(async () => new Response(bytes));
	const strict = await ToolCache.open(root, { fetch: download, npmrc: "min-release-age=4\n" });
	await expect(strict.materialise(tool, "darwin-arm64")).rejects.toMatchObject({ code: "toolFailed" });
	expect(download).not.toHaveBeenCalled();
	const relaxed = await ToolCache.open(root, { fetch: download, npmrc: "min-release-age=2.5\n" });
	expect(await relaxed.materialise(tool, "darwin-arm64")).toBeTruthy();
});

it.each([404, 204])("refuses HTTP %s or an absent body", async (status) => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const cache = await ToolCache.open(root, {
		fetch: async () => new Response(status === 404 ? bytes : null, { status }),
	});
	await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({
		code: "toolFailed",
		message: `Download failed: HTTP ${status}`,
	});
});

it("uses the default quarantine when npmrc omits the setting", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes), npmrc: "" });
	await expect(
		cache.materialise(
			{ ...testTool(bytes), published: new Date(Date.now() - 86_400_000).toISOString() },
			"darwin-arm64",
		),
	).rejects.toMatchObject({ code: "toolFailed" });
});

it.each([
	["null", "null"],
	["primitive", "1"],
	["format", '{"format_version":2}'],
	["wrong archive", `{"format_version":1,"archive":"wrong","binary":"${"a".repeat(64)}"}`],
	["wrong binary", '{"format_version":1,"binary":"wrong"}'],
	["binary hash", "a".repeat(64)],
	["oversized", " ".repeat(4097)],
] as const)("refuses a %s receipt", async (_case, receipt) => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	const tool = testTool(bytes);
	const binary = await cache.materialise(tool, "darwin-arm64");
	const path = join(dirname(binary), "receipt.json");
	const original = JSON.parse(await readFile(path, "utf8"));
	let text: string = receipt;
	if (_case === "oversized") text = JSON.stringify(original) + receipt;
	if (_case === "format") text = JSON.stringify({ ...original, format_version: 2 });
	if (_case === "wrong archive") text = JSON.stringify({ ...original, archive: "wrong" });
	if (_case === "binary hash") text = JSON.stringify({ ...original, binary: receipt });
	await writeFile(path, text);
	expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
});

it("refuses an archive swap even when executable and receipt remain unchanged", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	const tool = testTool(bytes);
	const binary = await cache.materialise(tool, "darwin-arm64");
	await writeFile(join(dirname(binary), "archive"), toolArchive([{ name: "enola", text: "forged" }]));
	expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
});

it.each([
	["archive", 128 * 1024 * 1024 + 1, true],
	["archive", 1, false],
	["binary", 96 * 1024 * 1024 + 1, true],
	["binary", 1, false],
] as const)("refuses a cached %s with size %s and regular-file state %s", async (file, size, regular) => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	const tool = testTool(bytes);
	const binary = await cache.materialise(tool, "darwin-arm64");
	const original = await vi.importActual<typeof fs>("node:fs/promises");
	vi.mocked(open).mockImplementation(async (...args) => {
		const handle = await original.open(...args);
		if (String(args[0]) === join(dirname(binary), file)) {
			const stat = await handle.stat();
			Object.defineProperty(stat, "size", { value: size });
			vi.spyOn(stat, "isFile").mockReturnValue(regular);
			vi.spyOn(handle, "stat").mockResolvedValue(stat);
		}
		return handle;
	});
	expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
	vi.mocked(open).mockImplementation(original.open);
});

it("refuses a non-executable cached binary", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	const tool = testTool(bytes);
	const binary = await cache.materialise(tool, "darwin-arm64");
	await chmod(binary, 0o600);
	expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
});

it("reuses a verified legacy flat entry and ignores unpublished entries", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const download = vi.fn(async () => new Response(bytes));
	const cache = await ToolCache.open(root, { fetch: download });
	const tool = testTool(bytes);
	const binary = await cache.materialise(tool, "darwin-arm64");
	const entry = dirname(binary),
		pin = dirname(entry);
	for (const file of ["archive", "binary", "receipt.json"]) await rename(join(entry, file), join(pin, file));
	await rm(entry, { recursive: true });
	expect(await cache.materialise(tool, "darwin-arm64")).toBe(join(pin, "binary"));
	expect(download).toHaveBeenCalledTimes(1);
	const hidden = join(pin, "unpublished");
	await mkdir(hidden);
	for (const file of ["archive", "binary", "receipt.json"]) await rename(join(pin, file), join(hidden, file));
	await writeFile(join(pin, "entry-file"), "not a directory");
	expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
});

it("reports a file at the pin directory as mismatched", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	const tool = testTool(bytes);
	const binary = await cache.materialise(tool, "darwin-arm64");
	const pin = dirname(dirname(binary));
	await rm(pin, { recursive: true });
	await writeFile(pin, "not a directory");
	expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
});

it("returns the concurrent verified winner instead of publishing again", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	let started!: () => void, release!: () => void;
	const beginning = new Promise<void>((resolve) => {
		started = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let count = 0;
	const cache = await ToolCache.open(root, {
		fetch: async () => {
			if (++count === 1) {
				started();
				await blocked;
			}
			return new Response(bytes);
		},
	});
	const tool = testTool(bytes);
	const pending = cache.materialise(tool, "darwin-arm64");
	await beginning;
	const winner = await cache.materialise(tool, "darwin-arm64");
	release();
	expect(await pending).toBe(winner);
	expect((await readdir(dirname(dirname(winner)))).filter((name) => name.startsWith("entry-"))).toHaveLength(1);
});

it("never exposes an empty pin directory when publication is interrupted", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const original = await vi.importActual<typeof fs>("node:fs/promises");
	vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("interrupted"), { code: "EIO" }));
	try {
		const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
		const tool = testTool(bytes);
		await expect(cache.materialise(tool, "darwin-arm64")).rejects.toMatchObject({ code: "toolFailed" });
		expect(await cache.readiness(tool, "darwin-arm64")).toBe("not-fetched");
		expect(await cache.materialise(tool, "darwin-arm64")).toMatch(/binary$/);
	} finally {
		vi.mocked(rename).mockImplementation(original.rename);
	}
});

it("refuses a publication changed before its final verification", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const original = await vi.importActual<typeof fs>("node:fs/promises");
	vi.mocked(rename).mockImplementation(async (from, to) => {
		await original.rename(from, to);
		const published = (await readdir(String(to))).find((name) => name.startsWith("entry-"));
		await writeFile(join(String(to), published ?? "", "binary"), "swapped");
	});
	try {
		const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
		await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({
			code: "invalidOutput",
			message: "Materialised tool failed verification",
		});
	} finally {
		vi.mocked(rename).mockImplementation(original.rename);
	}
});

it("caps streamed archive bytes before writing an oversized chunk", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(128 * 1024 * 1024 + 1));
			controller.close();
		},
	});
	const cache = await ToolCache.open(root, { fetch: async () => new Response(body) });
	await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({
		code: "outputTooLarge",
		message: "Tool archive exceeds 128 MiB",
	});
});

it("caps a standalone binary before publishing it", async () => {
	const bytes = Buffer.alloc(96 * 1024 * 1024 + 1);
	const tool = testTool(bytes);
	delete tool.platforms["darwin-arm64"]!.binary;
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	await expect(cache.materialise(tool, "darwin-arm64")).rejects.toMatchObject({
		code: "outputTooLarge",
		message: "Tool binary exceeds 96 MiB",
	});
});

it.each(["checksum", "octal", "truncated", "directory", "backslash", "prefix NUL", "large binary", "expanded entry"])(
	"rejects a tar %s defect",
	async (defect) => {
		let tar = gunzipSync(toolArchive([{ name: "enola", text: "trusted" }]));
		if (defect === "checksum") tar[100] = 1;
		else {
			if (defect === "octal") tar.write("bad", 124);
			if (defect === "truncated") tar.write("00000010000\0", 124);
			if (defect === "expanded entry") tar.write(`${(256 * 1024 * 1024 + 1).toString(8).padStart(11, "0")}\0`, 124);
			if (defect === "directory") tar.write("5", 156);
			if (defect === "backslash") tar.write("dir\\enola", 0);
			if (defect === "prefix NUL") tar.write("dir\0hidden", 345);
			if (defect === "large binary") {
				const size = 96 * 1024 * 1024 + 1;
				const header = Buffer.from(tar.subarray(0, 512));
				tar = Buffer.alloc(512 + Math.ceil(size / 512) * 512 + 1024);
				header.copy(tar);
				tar.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
			}
			tar.fill(32, 148, 156);
			const sum = tar.subarray(0, 512).reduce((total, byte) => total + byte, 0);
			tar.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
		}
		const bytes = gzipSync(tar);
		const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
		await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({
			code: "invalidOutput",
			...(defect === "truncated" || defect === "expanded entry"
				? { message: "Truncated tar entry" }
				: defect === "checksum" || defect === "octal"
					? { message: "Invalid tar header" }
					: {}),
		});
	},
);

it("caps gzip expansion at 256 MiB", async () => {
	const bytes = gzipSync(Buffer.alloc(256 * 1024 * 1024 + 1));
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	await expect(cache.materialise(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({
		code: "toolFailed",
		cause: { code: "ERR_BUFFER_TOO_LARGE" },
	});
});

it("propagates permission errors from readiness", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	const original = await vi.importActual<typeof fs>("node:fs/promises");
	vi.mocked(lstat).mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
	try {
		await expect(cache.readiness(testTool(bytes), "darwin-arm64")).rejects.toMatchObject({ code: "EACCES" });
	} finally {
		vi.mocked(lstat).mockImplementation(original.lstat);
	}
});

it("refuses a symlink to a byte-identical archive or receipt", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	const tool = testTool(bytes);
	const binary = await cache.materialise(tool, "darwin-arm64");
	for (const name of ["archive", "receipt.json"]) {
		const path = join(dirname(binary), name);
		const target = join(root, `copy-${name}`);
		await rename(path, target);
		await symlink(target, path);
		expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
		await rm(path);
		await rename(target, path);
	}
});

it("rejects an oversized cached standalone extraction before opening the binary", async () => {
	const bytes = Buffer.alloc(96 * 1024 * 1024 + 1);
	const tool = testTool(bytes);
	delete tool.platforms["darwin-arm64"]!.binary;
	const sha = tool.platforms["darwin-arm64"]!.sha256;
	const pin = join(root, "tools", tool.name, tool.version, "darwin-arm64", sha);
	await mkdir(pin, { recursive: true });
	await writeFile(join(pin, "archive"), bytes);
	await writeFile(join(pin, "receipt.json"), JSON.stringify({ format_version: 1, archive: sha, binary: sha }));
	vi.mocked(open).mockClear();
	const cache = await ToolCache.open(root, {
		fetch: async () => {
			throw new Error("No fetch");
		},
	});
	expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
	expect(vi.mocked(open).mock.calls.some(([path]) => String(path).endsWith("/binary"))).toBe(false);
});

it("refuses a symlink to a verified legacy entry directory", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	const tool = testTool(bytes);
	const binary = await cache.materialise(tool, "darwin-arm64");
	const entry = dirname(binary),
		pin = dirname(entry);
	for (const file of ["archive", "binary", "receipt.json"]) await rename(join(entry, file), join(pin, file));
	await rm(entry, { recursive: true });
	const target = join(root, "identical-entry");
	await rename(pin, target);
	await symlink(target, pin);
	expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
});

it("refuses a symlink to a pin directory containing published entries", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	const tool = testTool(bytes);
	const binary = await cache.materialise(tool, "darwin-arm64");
	const pin = dirname(dirname(binary));
	const target = join(root, "identical-pin");
	await rename(pin, target);
	await symlink(target, pin);
	expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
});

it("refuses an unpinned archive that extracts the same executable", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	const tool = testTool(bytes);
	const binary = await cache.materialise(tool, "darwin-arm64");
	await writeFile(
		join(dirname(binary), "archive"),
		toolArchive([
			{ name: "enola", text: "trusted" },
			{ name: "LICENSE", text: "different archive" },
		]),
	);
	expect(await cache.readiness(tool, "darwin-arm64")).toBe("mismatch");
});

it("accepts a receipt exactly at its size limit", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	const tool = testTool(bytes);
	const binary = await cache.materialise(tool, "darwin-arm64");
	const path = join(dirname(binary), "receipt.json");
	await writeFile(path, (await readFile(path, "utf8")).padEnd(4096, " "));
	expect(await cache.readiness(tool, "darwin-arm64")).toBe("verified");
});

it.each([
	["archive", 128 * 1024 * 1024],
	["binary", 96 * 1024 * 1024],
] as const)("accepts a cached %s exactly at its stat size limit", async (file, size) => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	const tool = testTool(bytes);
	const binary = await cache.materialise(tool, "darwin-arm64");
	const original = await vi.importActual<typeof fs>("node:fs/promises");
	vi.mocked(open).mockImplementation(async (...args) => {
		const handle = await original.open(...args);
		if (String(args[0]) === join(dirname(binary), file)) {
			const stat = await handle.stat();
			Object.defineProperty(stat, "size", { value: size });
			vi.spyOn(handle, "stat").mockResolvedValue(stat);
		}
		return handle;
	});
	try {
		expect(await cache.readiness(tool, "darwin-arm64")).toBe("verified");
	} finally {
		vi.mocked(open).mockImplementation(original.open);
	}
});

it("gives downloads a two-minute abort signal", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted" }]);
	const timeout = vi.spyOn(AbortSignal, "timeout");
	const download = vi.fn<ToolFetch>(async () => new Response(bytes));
	try {
		const cache = await ToolCache.open(root, { fetch: download });
		await cache.materialise(testTool(bytes), "darwin-arm64");
		expect(timeout).toHaveBeenCalledWith(120_000);
		expect(download.mock.calls[0]?.[1]?.signal).toBe(timeout.mock.results[0]?.value);
	} finally {
		timeout.mockRestore();
	}
});

it("accepts a standalone executable at the limit, including cached extraction", async () => {
	const bytes = Buffer.alloc(96 * 1024 * 1024);
	const tool = testTool(bytes);
	delete tool.platforms["darwin-arm64"]!.binary;
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	const binary = await cache.materialise(tool, "darwin-arm64");
	expect((await lstat(binary)).size).toBe(bytes.length);
	expect(await cache.readiness(tool, "darwin-arm64")).toBe("verified");
});

it("accepts the archive byte limit before refusing an oversized standalone executable", async () => {
	const bytes = Buffer.alloc(128 * 1024 * 1024);
	const tool = testTool(bytes);
	delete tool.platforms["darwin-arm64"]!.binary;
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	await expect(cache.materialise(tool, "darwin-arm64")).rejects.toMatchObject({
		code: "outputTooLarge",
		message: "Tool binary exceeds 96 MiB",
	});
});

it("accepts a tar binary at its size limit", async () => {
	const bytes = toolArchive([{ name: "enola", text: "x".repeat(96 * 1024 * 1024) }]);
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	const binary = await cache.materialise(testTool(bytes), "darwin-arm64");
	expect((await lstat(binary)).size).toBe(96 * 1024 * 1024);
});

it("accepts one complete closing zero header", async () => {
	const bytes = gzipSync(gunzipSync(toolArchive([{ name: "enola", text: "trusted" }])).subarray(0, -512));
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	expect(await readFile(await cache.materialise(testTool(bytes), "darwin-arm64"), "utf8")).toBe("trusted");
});

it("extracts a prefixed binary beside a directory entry", async () => {
	const tar = gunzipSync(
		toolArchive([
			{ name: "bin", text: "", kind: "5" },
			{ name: "enola", text: "trusted" },
		]),
	);
	const header = tar.subarray(512, 1024);
	header.write("bin", 345);
	header.fill(32, 148, 156);
	const sum = header.reduce((total, byte) => total + byte, 0);
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	const bytes = gzipSync(tar);
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	expect(await readFile(await cache.materialise(testTool(bytes, "bin/enola"), "darwin-arm64"), "utf8")).toBe(
		"trusted",
	);
});

it("accepts a NUL regular-file kind", async () => {
	const bytes = toolArchive([{ name: "enola", text: "trusted", kind: "" }]);
	const cache = await ToolCache.open(root, { fetch: async () => new Response(bytes) });
	expect(await readFile(await cache.materialise(testTool(bytes), "darwin-arm64"), "utf8")).toBe("trusted");
});
