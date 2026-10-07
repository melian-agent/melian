import { rmSync } from "node:fs";
import { Changeset } from "@melian-agent/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EnclosingFunctions } from "../src/enclosing-functions.ts";
import { baseAndHead, isolatedGitEnv, lines } from "./fixtures/repo.ts";

vi.mock("typescript/unstable/sync", () => ({
	API: class {
		constructor() {
			throw new Error("the compiler\nwould not start");
		}
	},
}));

let repo: string;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

it("says why the compiler could not be asked, with control characters escaped, and carries nothing", async () => {
	repo = baseAndHead(
		{ "src/a.ts": lines("export function f() {", "\treturn 1;", "}") },
		{ "src/a.ts": lines("export function f() {", "\treturn 2;", "}") },
	);
	const found = await EnclosingFunctions.read(await Changeset.resolve(repo, "main...feature"));
	expect(found.functions).toEqual([]);
	expect(found.unavailable).toBe("the compiler\\u000awould not start");
	const prompt = found.blocks(undefined, "c".repeat(24)).join("\n");
	expect(prompt).toContain("The head's functions could not be read");
	expect(prompt).not.toContain("compiler");
});

it("never asks the compiler when no file is TypeScript", async () => {
	repo = baseAndHead({ "a.py": "x = 1\n" }, { "a.py": "x = 2\n" });
	const found = await EnclosingFunctions.read(await Changeset.resolve(repo, "main...feature"));
	expect(found.unavailable).toBeUndefined();
});
