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

	it("reads nothing from a record that is not an object of exactly a code and a signal", () => {
		expect(record("\nnull\n")).toEqual(unknown);
		expect(record("\nnot json\n")).toEqual(unknown);
		expect(record('\n"ab"\n')).toEqual(unknown);
		expect(record('\n{"code":1,"signal":null,"extra":true}\n')).toEqual(unknown);
		expect(record('\n{"code":1}\n')).toEqual(unknown);
	});

	it("reads an exit code from 0 to 255, and nothing past either end", () => {
		const exit = (code: number) => record(`\n{"code":${code},"signal":null}\n`);
		expect(exit(0)).toEqual({ exitCode: 0, signal: null });
		expect(exit(255)).toEqual({ exitCode: 255, signal: null });
		expect(exit(-1)).toEqual(unknown);
		expect(exit(256)).toEqual(unknown);
		expect(exit(1.5)).toEqual(unknown);
		expect(record('\n{"code":1,"signal":"SIGKILL"}\n')).toEqual(unknown);
	});

	it("reads a signal only when the system names it", () => {
		expect(record('\n{"code":null,"signal":"SIGNOPE"}\n')).toEqual(unknown);
		expect(record('\n{"code":null,"signal":9}\n')).toEqual(unknown);
		expect(record('\n{"code":null,"signal":["SIGKILL"]}\n')).toEqual(unknown);
		expect(record('\n{"code":0,"signal":"SIGTERM"}\n')).toEqual(unknown);
	});

	it("reads nothing from no record", () => {
		expect(record("")).toEqual(unknown);
	});
});
