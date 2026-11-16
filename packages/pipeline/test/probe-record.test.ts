import { describe, expect, it } from "vitest";
import { endingOf } from "../src/probe.ts";

const unknown = { exitCode: null, signal: null };
const record = (text: string) => endingOf(Buffer.from(text, "utf8"));

// The runner writes "\n" + its record + "\n", so the record is the line between the last two newlines.
describe("the runner's record of how a probe ended", () => {
	it("reads a record with a newline on each side, after any stray bytes", () => {
		expect(record('\n{"code":1,"signal":null}\n')).toEqual({ exitCode: 1, signal: null });
		expect(record('stray\n{"code":null,"signal":"SIGKILL"}\n')).toEqual({ exitCode: null, signal: "SIGKILL" });
	});

	it("reads nothing from a record with no newline before it", () => {
		expect(record('{"code":1,"signal":null}\n')).toEqual(unknown);
	});

	it("reads nothing from a record with bytes after its last newline", () => {
		expect(record('\n{"code":1,"signal":null}\nx')).toEqual(unknown);
		expect(record('\n{"code":1,"signal":null}')).toEqual(unknown);
	});

	it("reads nothing from no record", () => {
		expect(record("")).toEqual(unknown);
	});
});
