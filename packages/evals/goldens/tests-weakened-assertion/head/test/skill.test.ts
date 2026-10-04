import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commandsIn } from "../src/commands.ts";

// The skill may run Melian and nothing else: the repository it reviews must not supply what the agent runs.
const allowed = new Set(["melian review", "melian doctor", "melian findings"]);

describe("the review skill", () => {
	it("runs only the commands it is allowed", () => {
		const commands = commandsIn(readFileSync("skills/review/SKILL.md", "utf8")).filter((command) =>
			command.startsWith("melian "),
		);
		expect(commands.length).toBeGreaterThan(0);
		for (const command of commands) expect(allowed.has(command.split(" ").slice(0, 2).join(" "))).toBe(true);
	});
});
