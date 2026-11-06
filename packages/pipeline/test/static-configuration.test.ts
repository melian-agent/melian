import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "@melian-agent/core";
import { backgroundContext as context, createNodeExecutionEnv, type StaticRunInput } from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Run } from "../src/static.ts";
import { ConfigurationScope } from "../src/static-configuration.ts";
import { writeFiles } from "./fixtures/repo.ts";

let root: string;
let outside: string;
let install: string;
const token = "ghp_FAKEoutsideTOKEN281";

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "melian-scope-root-")));
	outside = realpathSync(mkdtempSync(join(tmpdir(), "melian-scope-outside-")));
	install = realpathSync(mkdtempSync(join(tmpdir(), "melian-scope-install-")));
	writeFiles(outside, { "environ.json": `{"${token}": 1}\n` });
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of [root, outside, install]) rmSync(directory, { recursive: true, force: true });
});

function runFor(tool: "biome" | "tsc" | "mutation", env = createNodeExecutionEnv(root)): Run {
	const input: StaticRunInput = {
		env,
		repoRoot: root,
		commit: "0".repeat(40),
		tool,
		settings: { ...defaultConfig.static[tool], timeout: 60 },
	};
	return new Run(input, context);
}

async function refusal(
	tool: "biome" | "tsc" | "mutation",
	files: Record<string, string>,
	installed: { at: string | undefined } = { at: install },
) {
	writeFiles(root, files);
	return ConfigurationScope.refusal(runFor(tool), root, Object.keys(files), installed.at);
}

const secret = () => join(outside, "environ.json");

describe("ConfigurationScope with Biome", () => {
	it("refuses an absolute extends outside the checkout, naming it without reading it", async () => {
		const reason = await refusal("biome", { "biome.json": JSON.stringify({ extends: [secret()] }) });
		expect(reason).toBe(`biome.json names ${secret()}, which is outside the checkout`);
	});

	it("refuses a relative extends that climbs out of the checkout", async () => {
		const reason = await refusal("biome", { "biome.json": JSON.stringify({ extends: "../x/biome.json" }) });
		expect(reason).toBe("biome.json names ../x/biome.json, which is outside the checkout");
	});

	it("refuses an extends through a link that leaves the checkout", async () => {
		writeFiles(root, { "biome.json": JSON.stringify({ extends: ["./shared.json"] }) });
		symlinkSync(secret(), join(root, "shared.json"));
		const reason = await ConfigurationScope.refusal(runFor("biome"), root, ["biome.json", "shared.json"], install);
		expect(reason).toBe("biome.json names ./shared.json, which resolves outside the checkout");
	});

	it("refuses a configuration file that is itself a link out of the checkout", async () => {
		mkdirSync(join(root, "sub"));
		symlinkSync(secret(), join(root, "sub/.biome.jsonc"));
		const reason = await ConfigurationScope.refusal(runFor("biome"), root, ["sub/.biome.jsonc"], install);
		expect(reason).toBe("sub/.biome.jsonc resolves outside the checkout");
	});

	it("follows the chain through a file the configuration extends", async () => {
		const reason = await refusal("biome", {
			"biome.json": JSON.stringify({ extends: ["configs/base.json"] }),
			"configs/base.json": JSON.stringify({ extends: [secret()] }),
		});
		expect(reason).toBe(`biome.json names configs/base.json, which names ${secret()}, which is outside the checkout`);
	});

	it("checks every file Biome reads as configuration, and no other", async () => {
		const extending = JSON.stringify({ extends: [secret()] });
		expect(await refusal("biome", { "a/xbiome.json": extending, "b/biome.json.bak": extending })).toBeUndefined();
		expect(await refusal("biome", { ".config/biome.jsonc": extending })).toMatch(/^\.config\/biome\.jsonc names/);
		expect(await refusal("biome", { ".biome.json": extending })).toMatch(/^\.biome\.json names/);
	});

	it("checks each configuration file after one that names nothing outside", async () => {
		const reason = await refusal("biome", {
			"biome.json": "{}",
			"sub/biome.json": JSON.stringify({ extends: [secret()] }),
		});
		expect(reason).toBe(`sub/biome.json names ${secret()}, which is outside the checkout`);
	});

	it("reads a path entry as Biome does, with no .json added and only a final .json making a path", async () => {
		expect(
			await refusal("biome", {
				"biome.json": JSON.stringify({ extends: ["./base"] }),
				"base.json": JSON.stringify({ extends: [secret()] }),
			}),
		).toBeUndefined();
		expect(await refusal("biome", { "biome.json": JSON.stringify({ extends: ["base.json/x"] }) })).toBe(
			"biome.json names the package base.json, which the checkout's install does not provide",
		);
	});

	it("refuses a plugin outside the checkout, by path or as a plain string", async () => {
		const grit = join(outside, "rule.grit");
		for (const plugins of [[{ path: grit }], [grit], grit]) {
			rmSync(join(root, "biome.json"), { force: true });
			const reason = await refusal("biome", { "biome.json": JSON.stringify({ plugins }) });
			expect(reason).toBe(`biome.json names ${grit}, which is outside the checkout`);
		}
	});

	it("accepts the root configuration, files inside the checkout, a loop and a missing file", async () => {
		const reason = await refusal("biome", {
			"biome.json": JSON.stringify({
				extends: ["./a.json", "./missing.json"],
				plugins: [{ path: "./rule.grit" }, 7, null],
			}),
			"a.json": JSON.stringify({ extends: ["./biome.json"] }),
			"sub/biome.json": JSON.stringify({ extends: "//" }),
			"rule.grit": "`debugger`",
		});
		expect(reason).toBeUndefined();
	});

	it("refuses a configuration it cannot read as an object, since it cannot tell what Biome would follow", async () => {
		for (const text of ['{"extends": ["/x"] "y"}', "[]", '"text"', "null"]) {
			const reason = await refusal("biome", { "biome.json": text });
			expect(reason).toBe(
				"biome.json is not JSON Melian can read, so it cannot tell which files biome would read through it",
			);
		}
	});

	it("reports a path it cannot resolve for a reason other than absence", async () => {
		writeFiles(root, { "biome.json": "{}" });
		const env = createNodeExecutionEnv(root);
		vi.spyOn(env, "canonicalPath").mockImplementation(async (path) =>
			path === install
				? { ok: true, value: install }
				: {
						ok: false,
						error: Object.assign(new Error("permission denied"), { code: "permission_denied" as const }),
					},
		);
		const reason = await ConfigurationScope.refusal(runFor("biome", env), root, ["biome.json"], install);
		expect(reason).toBe("biome.json could not be resolved: permission denied");
	});
});

describe("ConfigurationScope with packages", () => {
	function installPackage(name: string): void {
		writeFiles(install, { [`${name}/biome.json`]: "{}" });
		mkdirSync(join(root, "node_modules", name, ".."), { recursive: true });
		symlinkSync(join(install, name), join(root, "node_modules", name));
	}

	it("accepts a package the checkout's install provides, scoped or not", async () => {
		installPackage("shared");
		installPackage("@team/lint");
		const reason = await refusal("biome", {
			"biome.json": JSON.stringify({ extends: ["shared", "@team/lint/strict"] }),
		});
		expect(reason).toBeUndefined();
	});

	it("refuses a package the install does not provide, or any package when there is no install", async () => {
		installPackage("shared");
		expect(await refusal("biome", { "biome.json": JSON.stringify({ extends: ["absent"] }) })).toBe(
			"biome.json names the package absent, which the checkout's install does not provide",
		);
		expect(await refusal("biome", { "biome.json": JSON.stringify({ extends: ["shared"] }) }, { at: undefined })).toBe(
			"biome.json names the package shared, which the checkout's install does not provide",
		);
		expect(await refusal("biome", { "biome.json": JSON.stringify({ extends: ["~/environ"] }) })).toBe(
			"biome.json names the package ~, which the checkout's install does not provide",
		);
	});

	it("refuses an install whose path cannot be resolved", async () => {
		installPackage("shared");
		writeFiles(root, { "biome.json": JSON.stringify({ extends: ["shared"] }) });
		const reason = await ConfigurationScope.refusal(runFor("biome"), root, ["biome.json"], join(root, "gone"));
		expect(reason).toBe("biome.json names the package shared, which the checkout's install does not provide");
	});

	it("refuses a package that resolves to the revision's own files, or climbs out of its directory", async () => {
		writeFiles(root, { "packages/own/biome.json": "{}" });
		mkdirSync(join(root, "node_modules"));
		symlinkSync(join(root, "packages/own"), join(root, "node_modules/own"));
		installPackage("shared");
		expect(await refusal("biome", { "biome.json": JSON.stringify({ extends: ["own"] }) })).toBe(
			"biome.json names the package own, which the checkout's install does not provide",
		);
		expect(await refusal("biome", { "biome.json": JSON.stringify({ extends: ["shared/../../x"] }) })).toBe(
			"biome.json names shared/../../x, which climbs out of its package",
		);
	});

	it("accepts a path into the checkout's install", async () => {
		installPackage("shared");
		const reason = await refusal("biome", {
			"biome.json": JSON.stringify({ extends: ["./node_modules/shared/biome.json"] }),
		});
		expect(reason).toBeUndefined();
	});
});

describe("ConfigurationScope with tsc", () => {
	it("refuses an extends or a reference outside the checkout", async () => {
		expect(await refusal("tsc", { "tsconfig.json": JSON.stringify({ extends: secret() }) })).toBe(
			`tsconfig.json names ${secret()}, which is outside the checkout`,
		);
		expect(
			await refusal("tsc", {
				"tsconfig.json": JSON.stringify({ extends: ["./ok.json", secret()] }),
				"ok.json": "{}",
			}),
		).toBe(`tsconfig.json names ${secret()}, which is outside the checkout`);
		expect(await refusal("tsc", { "tsconfig.json": JSON.stringify({ references: [{ path: outside }] }) })).toBe(
			`tsconfig.json names ${outside}, which is outside the checkout`,
		);
	});

	it("follows an extends without its .json and a reference to a directory, as tsc does", async () => {
		expect(
			await refusal("tsc", {
				"tsconfig.json": JSON.stringify({ extends: "./base" }),
				"base.json": JSON.stringify({ extends: secret() }),
			}),
		).toBe(`tsconfig.json names ./base, which names ${secret()}, which is outside the checkout`);
		rmSync(join(root, "base.json"));
		expect(
			await refusal("tsc", {
				"tsconfig.json": JSON.stringify({ references: [{ path: "./packages/a" }, null] }),
				"packages/a/tsconfig.json": JSON.stringify({ extends: secret() }),
			}),
		).toBe(`tsconfig.json names ./packages/a, which names ${secret()}, which is outside the checkout`);
	});

	it("starts from the configured project and accepts a reference back to the checkout's root", async () => {
		const reason = await refusal("tsc", {
			"tsconfig.json": JSON.stringify({ references: [{ path: "./packages/a" }] }),
			"packages/a/tsconfig.json": JSON.stringify({ references: [{ path: "../.." }] }),
			"other.json": JSON.stringify({ extends: secret() }),
		});
		expect(reason).toBeUndefined();
	});

	it("reads a bare extends as a package, unlike Biome", async () => {
		const reason = await refusal("tsc", {
			"tsconfig.json": JSON.stringify({ extends: "configs/base.json" }),
			"configs/base.json": "{}",
		});
		expect(reason).toBe("tsconfig.json names the package configs, which the checkout's install does not provide");
	});
});

it("leaves every other tool alone", async () => {
	expect(await refusal("mutation", { "biome.json": JSON.stringify({ extends: [secret()] }) })).toBeUndefined();
});
