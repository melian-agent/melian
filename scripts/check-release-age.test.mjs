import { describe, expect, it } from "vitest";
import { findTooYoung, parseLockfile, readWindowDays } from "./check-release-age.mjs";

const now = Date.parse("2026-10-03T12:00:00Z");
const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
const tarball = (name, version) => `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`;

const lock = {
	packages: {
		"": { name: "root" },
		"node_modules/old": { version: "1.0.0", resolved: tarball("old", "1.0.0") },
		"node_modules/fresh": { version: "2.0.0", resolved: tarball("fresh", "2.0.0") },
		"node_modules/@scope/excepted": { version: "3.0.0", resolved: tarball("@scope/excepted", "3.0.0") },
		"node_modules/@w/a": { resolved: "packages/a", link: true },
		"packages/a": { name: "@w/a", version: "0.0.0" },
	},
};

const times = new Map([
	["old", { "1.0.0": "2020-01-01T00:00:00Z" }],
	["fresh", { "2.0.0": hourAgo }],
	["@scope/excepted", { "3.0.0": hourAgo }],
]);

const exception = { name: "@scope/excepted", version: "3.0.0", reason: "reviewed", added: "2026-10-03" };

describe("parseLockfile", () => {
	it("keeps registry entries and skips the root and workspace links", () => {
		const { entries, foreign } = parseLockfile(lock);
		expect(entries.map((entry) => entry.name)).toEqual(["old", "fresh", "@scope/excepted"]);
		expect(foreign).toEqual([]);
	});

	it("reports entries that resolve outside the registry", () => {
		const { foreign } = parseLockfile({
			packages: { "node_modules/x": { version: "1.0.0", resolved: "https://example.com/x-1.0.0.tgz" } },
		});
		expect(foreign.map((entry) => entry.name)).toEqual(["x"]);
	});
});

describe("findTooYoung", () => {
	it("reports only the young entry without an exception", () => {
		const { entries } = parseLockfile(lock);
		const { tooYoung, excepted } = findTooYoung({ entries, times, now, windowDays: 2, exceptions: [exception] });
		expect(tooYoung.map((entry) => `${entry.name}@${entry.version}`)).toEqual(["fresh@2.0.0"]);
		expect(excepted.map((entry) => entry.exception)).toEqual([exception]);
	});

	it("reports a version the registry has no publish time for", () => {
		const entries = [{ path: "node_modules/old", name: "old", version: "9.9.9" }];
		const { tooYoung } = findTooYoung({ entries, times, now, windowDays: 2, exceptions: [] });
		expect(tooYoung).toHaveLength(1);
	});
});

describe("readWindowDays", () => {
	it("reads min-release-age and defaults to two days", () => {
		expect(readWindowDays("save-exact=true\nmin-release-age=5\n")).toBe(5);
		expect(readWindowDays("save-exact=true\n")).toBe(2);
		expect(readWindowDays(undefined)).toBe(2);
	});
});
