import {
	Adjudication,
	type CheckRecord,
	defaultConfig,
	Finding,
	type FindingInput,
	withheldToolText,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { evalInput } from "./fixtures/findings.ts";

const said = withheldToolText("static.tsc", "tsc/TS2322");

// A tsc finding as this build writes it, with `input` replacing any field.
function tsc(input: Partial<FindingInput> = {}): Finding {
	return Finding.create({
		rule: "tsc/TS2322",
		message: said,
		file: "src/a.ts",
		startLine: 2,
		snippet: "export const n: number = 'x';",
		occurrence: 0,
		cause: "introduced",
		severity: "P1",
		explanation: { what: said, whyHere: "tsc reports this at head.", whatToDo: "Change the code." },
		source: { check: "static.tsc", version: "7.0.2" },
		...input,
	});
}

const unread = { snippet: undefined, occurrence: undefined };

describe("Finding.quotesTool", () => {
	it("passes a Biome or tsc finding that holds only Melian's sentence, in each form Melian writes", () => {
		expect(tsc().quotesTool()).toBe(false);
		expect(tsc({ message: `${said} (and 2 more on these lines)` }).quotesTool()).toBe(false);
		expect(
			tsc({
				...unread,
				message: `3 more tsc/TS2322 result(s) on these lines than at the base: ${said}`,
				discriminator: "beyond the base at 0123456789abcdef",
			}).quotesTool(),
		).toBe(false);
		expect(tsc({ ...unread, discriminator: "line 12, column 3" }).quotesTool()).toBe(false);
		expect(tsc({ ...unread, discriminator: "line 12, column 34" }).quotesTool()).toBe(false);
		const biome = withheldToolText("static.biome", "biome/suspicious/noDebugger");
		expect(
			tsc({
				rule: "biome/suspicious/noDebugger",
				message: biome,
				explanation: { what: biome, whyHere: "w", whatToDo: "t" },
				source: { check: "static.biome" },
			}).quotesTool(),
		).toBe(false);
	});

	it("catches a tool's text in the message, the explanation or the discriminator", () => {
		expect(tsc({ message: "Type 'number' is not assignable to type 'ghp_FAKE'." }).quotesTool()).toBe(true);
		expect(tsc({ message: `${said} ghp_FAKE` }).quotesTool()).toBe(true);
		expect(tsc({ message: `ghp_FAKE ${said}` }).quotesTool()).toBe(true);
		expect(tsc({ message: `${said} (and two more on these lines)` }).quotesTool()).toBe(true);
		expect(tsc({ message: `${said} (and 2 more on these lines) ghp_FAKE` }).quotesTool()).toBe(true);
		expect(
			tsc({
				...unread,
				message: `x more tsc/TS2322 result(s) on these lines than at the base: ${said}`,
				discriminator: "line 1, column 1",
			}).quotesTool(),
		).toBe(true);
		expect(tsc({ explanation: { what: "ghp_FAKE", whyHere: "w", whatToDo: "t" } }).quotesTool()).toBe(true);
		expect(tsc({ ...unread, discriminator: "Type 'number' is not assignable" }).quotesTool()).toBe(true);
		expect(tsc({ ...unread, discriminator: "line 12, column 3 ghp_FAKE" }).quotesTool()).toBe(true);
		expect(tsc({ ...unread, discriminator: "ghp_FAKE line 12, column 3" }).quotesTool()).toBe(true);
		expect(tsc({ ...unread, discriminator: "beyond the base at 0123456789abcdeg" }).quotesTool()).toBe(true);
	});

	it("reads the sentence for the finding's own tool and rule", () => {
		expect(tsc({ source: { check: "static.biome" } }).quotesTool()).toBe(true);
		const other = withheldToolText("static.tsc", "tsc/TS2XXX");
		expect(
			tsc({
				rule: "tsc/TS2.XX",
				message: other,
				explanation: { what: other, whyHere: "w", whatToDo: "t" },
			}).quotesTool(),
		).toBe(true);
		const dotted = withheldToolText("static.tsc", "tsc/TS2.XX");
		expect(
			tsc({
				...unread,
				rule: "tsc/TS2.XX",
				message: `1 more tsc/TS2AXX result(s) on these lines than at the base: ${dotted}`,
				discriminator: "line 1, column 1",
				explanation: { what: dotted, whyHere: "w", whatToDo: "t" },
			}).quotesTool(),
		).toBe(true);
	});

	it("leaves every other check's finding alone", () => {
		expect(Finding.create(evalInput).quotesTool()).toBe(false);
		expect(tsc({ source: { check: "static.enola" } }).quotesTool()).toBe(false);
	});
});

describe("Verdict.quotesTool", () => {
	const verdict = (findings: Finding[], checks: CheckRecord[]) =>
		new Adjudication({
			findings,
			manifest: checks.map((check) => check.name),
			checks,
			config: defaultConfig,
		}).adjudicate();
	const failed = (name: string, error: string): CheckRecord => ({
		name,
		status: "failed",
		reason: "toolFailed",
		error,
	});
	const biomeNow =
		"biome exited with code 1 and no report; run biome lint at 0123456789ab to see why, since Melian keeps none of its stderr";
	const tscNow =
		"tsc exited with code 134 on tsconfig.json; run tsc --noEmit -p tsconfig.json at 0123456789ab to see why, since Melian keeps none of its output";

	it("passes the findings and failures this build writes, and other checks' failures", () => {
		expect(verdict([tsc()], [{ name: "static.tsc", status: "ran" }]).quotesTool()).toBe(false);
		expect(verdict([], [failed("static.biome", biomeNow), failed("static.tsc", tscNow)]).quotesTool()).toBe(false);
		expect(verdict([], [failed("static.biome", biomeNow.replace("code 1 ", "code 137 "))]).quotesTool()).toBe(false);
		expect(verdict([], [failed("static.mutation", "mutation exited with code 1: Stryker's tail")]).quotesTool()).toBe(
			false,
		);
		expect(verdict([], [failed("static.biome", "biome ran past its 3600-second timeout")]).quotesTool()).toBe(false);
		expect(
			verdict([], [failed("lens.correctness", "biome exited with code 1 and no report: ghp")]).quotesTool(),
		).toBe(false);
	});

	it("catches a finding or a failed run that carries a tool's text", () => {
		expect(verdict([tsc({ message: "ghp_FAKE" })], [{ name: "static.tsc", status: "ran" }]).quotesTool()).toBe(true);
		expect(
			verdict([], [failed("static.biome", "biome exited with code 1 and no report: ghp_FAKE")]).quotesTool(),
		).toBe(true);
		expect(
			verdict([], [failed("static.tsc", "tsc exited with code 2 on tsconfig.json: ghp_FAKE")]).quotesTool(),
		).toBe(true);
		expect(
			verdict([], [failed("static.tsc", tscNow.replace("-p tsconfig.json", "-p other.json"))]).quotesTool(),
		).toBe(true);
		expect(verdict([], [failed("static.biome", `${biomeNow} ghp`)]).quotesTool()).toBe(true);
		expect(verdict([], [failed("static.tsc", `${tscNow} ghp`)]).quotesTool()).toBe(true);
		expect(
			verdict(
				[],
				[failed("static.tsc", tscNow), failed("static.biome", "biome exited with code 1 and no report: g")],
			).quotesTool(),
		).toBe(true);
	});

	it("reads the checks that ran as well as those that did not", () => {
		const ran: CheckRecord = { name: "static.tsc", status: "ran", error: "tsc exited with code 2 on a: ghp_FAKE" };
		expect(verdict([], [ran]).quotesTool()).toBe(true);
	});
});
