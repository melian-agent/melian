import { createHash } from "node:crypto";
import { findPackageJSON } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type * as Installed from "../src/installed-packages.ts";

const table = vi.hoisted(() => ({
	moduleHashes: { "a.ts": "1", "b.ts": "2" } as Record<string, string>,
	producerModules: { lens: ["a.ts", "b.ts"], broken: ["a.ts", "missing.ts"] } as Record<string, string[]>,
	producerPackages: {
		lens: { "@melian-agent/core": ["yaml"], "@melian-agent/pipeline": ["typescript"] },
		read: { "@melian-agent/core": ["yaml"] },
		owners: { "@melian-agent/core": ["yaml"], "@melian-agent/pipeline": ["typescript"] },
		unowned: { "@melian-agent/absent": ["yaml"] },
		uninstalled: { "@melian-agent/core": ["left-pad"] },
	} as Record<string, Record<string, string[]>>,
}));
vi.mock("../src/code-hashes.ts", () => table);
const digested = vi.hoisted(() => [] as unknown[]);
const outsideOf = vi.hoisted(() => new Map<string, string[]>());
vi.mock("../src/installed-packages.ts", async (original) => {
	const real = await original<typeof Installed>();
	return {
		...real,
		installedPackagesDigest: (roots: Parameters<typeof Installed.installedPackagesDigest>[0]) => {
			digested.push(roots);
			return real.installedPackagesDigest(roots);
		},
		packagesOutsideInstall: (roots: Parameters<typeof Installed.packagesOutsideInstall>[0]) =>
			outsideOf.get(roots.map((root) => `${root.by} ${root.name}`).join(",")) ?? real.packagesOutsideInstall(roots),
	};
});

import { codeVersion, packagesVersion, unidentifiedPackages } from "../src/code-version.ts";
import { installedPackagesDigest } from "../src/installed-packages.ts";

describe("codeVersion", () => {
	it("hashes each of the producer's modules as a path and its hash, one per line", () => {
		expect(codeVersion("lens")).toBe(createHash("sha256").update("a.ts 1\nb.ts 2\n").digest("hex"));
	});

	it("moves when one of the producer's module hashes moves", () => {
		const before = codeVersion("lens");
		table.moduleHashes["b.ts"] = "3";
		try {
			expect(codeVersion("lens")).not.toBe(before);
		} finally {
			table.moduleHashes["b.ts"] = "2";
		}
	});

	it("refuses a producer the table does not hold, an inherited name included", () => {
		expect(() => codeVersion("other")).toThrow("no code is recorded for the producer other");
		expect(() => codeVersion("toString")).toThrow("no code is recorded for the producer toString");
	});

	it("refuses a module whose hash the table does not hold, an inherited name included", () => {
		expect(() => codeVersion("broken")).toThrow("broken reaches missing.ts, whose hash is not recorded");
		table.producerModules.inherited = ["constructor"];
		expect(() => codeVersion("inherited")).toThrow("inherited reaches constructor, whose hash is not recorded");
	});
});

describe("packagesVersion", () => {
	const at = (name: string) => findPackageJSON(name, new URL("../src/code-version.ts", import.meta.url).href)!;

	it("digests what each recorded import installs, resolved from the package that imports it", () => {
		expect(packagesVersion("lens")).toBe(
			installedPackagesDigest([
				{ name: "yaml", from: at("@melian-agent/core"), by: "@melian-agent/core" },
				{ name: "typescript", from: at("@melian-agent/pipeline"), by: "@melian-agent/pipeline" },
			]),
		);
		expect(packagesVersion("lens")).not.toBe(packagesVersion("read"));
	});

	it("resolves each import from the manifest of the package that imports it", () => {
		digested.length = 0;
		packagesVersion("owners");
		expect(digested).toEqual([
			[
				{ name: "yaml", from: at("@melian-agent/core"), by: "@melian-agent/core" },
				{ name: "typescript", from: at("@melian-agent/pipeline"), by: "@melian-agent/pipeline" },
			],
		]);
	});

	it("reads the install once a process", () => {
		const before = packagesVersion("read");
		table.producerPackages.read = { "@melian-agent/pipeline": ["typescript"] };
		expect(packagesVersion("read")).toBe(before);
	});

	it("refuses a producer the table does not hold, an inherited name included", () => {
		expect(() => packagesVersion("other")).toThrow("no packages are recorded for the producer other");
		expect(() => packagesVersion("toString")).toThrow("no packages are recorded for the producer toString");
	});

	it("fails, naming it, on an importing package Melian cannot find", () => {
		expect(() => packagesVersion("unowned")).toThrow("Melian cannot find its own package @melian-agent/absent.");
	});

	it("fails, naming it, on an import that is not installed, and keys no partial list", () => {
		expect(() => packagesVersion("uninstalled")).toThrow(
			"Melian cannot find the installed package left-pad, which @melian-agent/core needs.",
		);
		expect(() => packagesVersion("uninstalled")).toThrow("left-pad");
	});
});

describe("unidentifiedPackages", () => {
	it("names nothing for an install that holds every package", () => {
		const { unowned, uninstalled, ...installed } = table.producerPackages;
		const before = table.producerPackages;
		table.producerPackages = installed;
		try {
			expect(unidentifiedPackages()).toEqual([]);
		} finally {
			table.producerPackages = before;
		}
	});

	it("names each release a link takes out of the install once, sorted, across every producer", () => {
		const before = table.producerPackages;
		table.producerPackages = {
			lens: { "@melian-agent/core": ["yaml"], "@melian-agent/pipeline": ["typescript"] },
			read: { "@melian-agent/core": ["yaml"] },
		};
		outsideOf.set("@melian-agent/core yaml,@melian-agent/pipeline typescript", ["yaml@2.9.1", "typescript@6.0.3"]);
		outsideOf.set("@melian-agent/core yaml", ["yaml@2.9.1"]);
		try {
			expect(unidentifiedPackages()).toEqual(["typescript@6.0.3", "yaml@2.9.1"]);
		} finally {
			table.producerPackages = before;
			outsideOf.clear();
		}
	});

	it("fails, naming it, on an importing package Melian cannot find", () => {
		expect(() => unidentifiedPackages()).toThrow("Melian cannot find its own package @melian-agent/absent.");
	});
});
