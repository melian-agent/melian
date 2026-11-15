import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { hostFacts } from "@melian-agent/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const actualExists = (await vi.importActual<typeof import("node:fs")>("node:fs")).existsSync;
const directories: string[] = [];

function scratch(): string {
	const directory = fs.mkdtempSync(join(tmpdir(), "melian-host-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	vi.mocked(fs.existsSync).mockImplementation(actualExists);
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("hostFacts", () => {
	it("names this process's platform, architecture and Node", () => {
		const facts = hostFacts(scratch());
		expect(facts).toEqual({
			platform: process.platform,
			arch: process.arch,
			node: process.versions.node,
			caseFolds: facts.caseFolds,
		});
	});

	it("asks the filesystem under the directory whether two spellings are one name, and leaves nothing there", () => {
		const directory = scratch();
		fs.writeFileSync(join(directory, "Witness"), "");
		const folds = actualExists(join(directory, "wITNESS"));
		fs.rmSync(join(directory, "Witness"));
		expect(hostFacts(directory).caseFolds).toBe(folds);
		expect(fs.readdirSync(directory)).toEqual([]);
	});

	it("says a folding filesystem folds, from the file it wrote", () => {
		vi.mocked(fs.existsSync).mockImplementation((path) =>
			actualExists(join(dirname(String(path)), basename(String(path)).toLowerCase())),
		);
		expect(hostFacts(scratch()).caseFolds).toBe(true);
	});

	it("asks each directory once", () => {
		const directory = scratch();
		const first = hostFacts(directory).caseFolds;
		fs.rmSync(directory, { recursive: true });
		expect(hostFacts(directory).caseFolds).toBe(first);
	});
});
