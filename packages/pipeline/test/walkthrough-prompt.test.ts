import { rmSync } from "node:fs";
import { Changeset } from "@melian-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { WalkthroughPrompt } from "../src/summarize.ts";
import { baseAndHead } from "./fixtures/repo.ts";

const repos: string[] = [];
afterEach(() => {
	for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

const cutNote = "[The remaining files were not read for the summary.]";

async function prompt(files: Record<string, string>) {
	const repo = baseAndHead({ "README.md": "Base.\n" }, files);
	repos.push(repo);
	const text = (await WalkthroughPrompt.read(await Changeset.resolve(repo, "main...feature"))).render(
		"0f0f0f0f0f0f0f0f",
	);
	const blocks = [
		...text.matchAll(/<untrusted-0f0f0f0f0f0f0f0f label="file">\n([\s\S]*?)\n<\/untrusted-0f0f0f0f0f0f0f0f>/g),
	].map((block) => block[1]!);
	return { text, blocks };
}

const small = (count: number) =>
	Object.fromEntries(
		Array.from({ length: count }, (_, index) => [`src/f${String(index).padStart(3, "0")}.ts`, "x\n"]),
	);

describe("WalkthroughPrompt", () => {
	it("reads all of a change of 100 files, and says nothing was left out", async () => {
		const { text, blocks } = await prompt(small(100));

		expect(blocks).toHaveLength(100);
		expect(text).not.toContain(cutNote);
	});

	it("reads 100 files of a change of 101, and says the rest were left out", async () => {
		const { text, blocks } = await prompt(small(101));

		expect(blocks).toHaveLength(100);
		expect(text).toContain(cutNote);
		expect(text).not.toContain("src/f100.ts");
	});

	it("stops once the files read reach exactly the input budget", async () => {
		// Eight files cut at 12,000 characters, then one whose text, `2 × 1981 + 24 + 14` characters, spends the last 4,000.
		const files = Object.fromEntries(
			Array.from({ length: 8 }, (_, index) => [
				`src/file0${index}.ts`,
				`export const value = "${"x".repeat(6500)}";\n`,
			]),
		);
		files["src/file08x.ts"] = `${"y".repeat(1981)}\n`;
		files["src/file09.ts"] = "z\n";

		const { text, blocks } = await prompt(files);

		expect(blocks.map((block) => block.length)).toEqual([...Array(8).fill(12_000), 4000]);
		expect(text).toContain(cutNote);
		expect(text).not.toContain("src/file09.ts");
	});
});
