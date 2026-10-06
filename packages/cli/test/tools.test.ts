import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolManifest } from "@melian-agent/core";
import { CacheLocation, ToolProvisioning } from "@melian-agent/pipeline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRepository, removeRepository } from "../../pipeline/test/fixtures/repo.ts";
import { testTool, toolArchive } from "../../pipeline/test/fixtures/tool-archive.ts";
import type { Io } from "../src/commands.ts";
import { main } from "../src/main.ts";
import { stateDirectory } from "../src/repository.ts";
import { ToolInventory } from "../src/tools.ts";

let repo: string;
beforeEach(() => {
	repo = createRepository();
});
afterEach(() => {
	vi.restoreAllMocks();
	removeRepository(repo);
});

function output(): Io & { lines: string[]; errors: string[] } {
	const lines: string[] = [];
	const errors: string[] = [];
	return {
		cwd: repo,
		env: { GH_TOKEN: "test", XDG_CONFIG_HOME: join(repo, "config"), PI_CODING_AGENT_DIR: join(repo, "pi") },
		stdout: (text) => lines.push(text),
		stderr: (text) => errors.push(text),
		color: false,
		lines,
		errors,
	};
}

it("lists readiness without downloading, verifies fetched pins and repairs a mismatch", async () => {
	const script = "#!/bin/sh\nexit 0\n";
	const bytes = toolArchive([{ name: "enola", text: script }]);
	const { name, ...pin } = testTool(bytes);
	const download = vi.fn(async () => new Response(bytes));
	const provisioning = await ToolProvisioning.open(repo, {
		manifest: ToolManifest.parse(JSON.stringify({ format_version: 1, tools: { [name]: pin }, misses: [] })),
		root: join(repo, "cache"),
		platform: "darwin-arm64",
		fetch: download,
	});
	const inventory = await ToolInventory.open(repo, {}, provisioning);
	vi.spyOn(ToolInventory, "open").mockResolvedValue(inventory);
	const io = output();
	expect(await main(["tools"], io)).toBe(0);
	expect(io.lines.join("")).toContain("enola@0.0.1  darwin-arm64  not yet fetched");
	expect(download).not.toHaveBeenCalled();
	io.lines.length = 0;
	expect(await main(["tools", "fetch", "enola"], io)).toBe(0);
	const binary = io.lines.join("").trim();
	expect(await readFile(binary, "utf8")).toBe(script);
	expect(await inventory.render()).toContain("materialised and verified");
	await writeFile(binary, "swapped");
	expect(await inventory.render()).toContain("manifest mismatch");
	expect(await main(["doctor"], io)).toBe(1);
	expect(io.lines.join("")).toMatch(/fail\s+tool enola\s+0\.0\.1; manifest mismatch/);
	expect(await main(["tools", "fetch", "enola"], io)).toBe(0);
	expect(download).toHaveBeenCalledTimes(2);
	expect(await inventory.render()).toContain("materialised and verified");
});

it("lists Melian's own manifest using the host's state directory", async () => {
	const io = output();
	io.env.MELIAN_STATE_DIR = join(repo, "host-state");
	expect(await main(["tools"], io)).toBe(0);
	expect(io.lines.join("")).toContain("enola@0.4.27");
	expect(io.lines.join("")).toContain("not yet fetched");
	expect(io.errors).toEqual([]);
});

it("reports doctor checks outside a git repository", async () => {
	await rm(join(repo, ".git"), { recursive: true });
	const io = output();
	expect(await main(["doctor"], io)).toBe(0);
	expect(io.lines.join("")).toContain("Melian needs 22.19.0 or later");
	expect(io.errors).toEqual([]);
});

it.each([new Error("inventory unavailable"), "inventory unavailable"])(
	"reports inventory read failures in doctor: %s",
	async (failure) => {
		vi.spyOn(ToolInventory, "open").mockRejectedValue(failure);
		const io = output();
		expect(await main(["doctor"], io)).toBe(1);
		expect(io.lines.join("")).toMatch(/fail\s+tools\s+inventory unavailable/);
	},
);

it.each([new Error("pin unreadable"), "pin unreadable"])(
	"reports a failed readiness probe without fetching: %s",
	async (failure) => {
		const provisioning = await ToolProvisioning.open(repo, { root: join(repo, "cache") });
		const inventory = await ToolInventory.open(repo, {}, provisioning);
		vi.spyOn(provisioning.cache, "readiness").mockRejectedValue(failure);
		const fetch = vi.spyOn(provisioning, "binary");
		expect(await inventory.readiness()).toEqual([
			{
				name: "enola",
				version: "0.4.27",
				state: "unavailable",
				detail: "cannot check: pin unreadable",
			},
		]);
		expect(fetch).not.toHaveBeenCalled();
	},
);

it("reports a platform with no pin as unavailable, never as a mismatch", async () => {
	const provisioning = await ToolProvisioning.open(repo, { root: join(repo, "cache"), platform: "linux-s390x" });
	const inventory = await ToolInventory.open(repo, {}, provisioning);
	expect(await inventory.readiness()).toEqual([
		{
			name: "enola",
			version: "0.4.27",
			state: "unavailable",
			detail: "cannot check: enola has no pin for linux-s390x",
		},
	]);
});

it("warns in doctor about a tool it cannot check, and exits 0", async () => {
	const provisioning = await ToolProvisioning.open(repo, { root: join(repo, "cache"), platform: "linux-s390x" });
	vi.spyOn(ToolInventory, "open").mockResolvedValue(await ToolInventory.open(repo, {}, provisioning));
	const io = output();
	expect(await main(["doctor"], io)).toBe(0);
	expect(io.lines.join("")).toMatch(/warn\s+tool enola\s+0\.4\.27; cannot check: enola has no pin for linux-s390x/);
});

it.each([
	["tools", "fetch"],
	["tools", "fetch", "enola", "extra"],
	["tools", "other"],
])("refuses unreadable tool arguments %j", async (...args) => {
	const io = output();
	expect(await main(args, io)).toBe(64);
	expect(io.errors.join("")).toContain("tools takes no arguments or fetch <name>");
});

it("uses one clone-directory rule for tools and review storage", async () => {
	for (const env of [{}, { MELIAN_STATE_DIR: "relative-state" }, { MELIAN_STATE_DIR: join(repo, "host-state") }]) {
		expect(await stateDirectory(repo, env)).toBe((await CacheLocation.open(repo, env)).root);
	}
});

it("renders control characters in a missing tool name as visible text", async () => {
	const io = output();
	expect(await main(["tools", "fetch", "\u001b[2J\nforged"], io)).toBe(1);
	expect(io.errors.join("")).toContain("\\u001b[2J\\u000aforged");
	expect(io.errors.join("")).not.toContain("\u001b");
});

it("renders control characters in a fetched executable path as visible text", async () => {
	const bytes = toolArchive([{ name: "enola", text: "#!/bin/sh\nexit 0\n" }]);
	const { name, ...pin } = testTool(bytes);
	const io = output();
	io.env.MELIAN_STATE_DIR = join(repo, "cache\u001b]0;forged title\u0007");
	const provisioning = await ToolProvisioning.open(repo, {
		manifest: ToolManifest.parse(JSON.stringify({ format_version: 1, tools: { [name]: pin }, misses: [] })),
		root: await stateDirectory(repo, io.env),
		platform: "darwin-arm64",
		fetch: async () => new Response(bytes),
	});
	const inventory = await ToolInventory.open(repo, io.env, provisioning);
	vi.spyOn(ToolInventory, "open").mockResolvedValue(inventory);
	expect(await main(["tools", "fetch", "enola"], io)).toBe(0);
	expect(io.lines.join("")).toBe(
		`${(await inventory.fetch("enola")).replace("\u001b", "\\u001b").replace("\u0007", "\\u0007")}\n`,
	);
	expect(io.lines.join("")).not.toContain("\u001b");
	expect(io.lines.join("")).not.toContain("\u0007");
});
