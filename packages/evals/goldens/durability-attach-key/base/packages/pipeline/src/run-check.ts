import { type CheckRecord, evaluateGuardrails, runStaticTool } from "@melian-agent/core";
import type { ChecksInput } from "./checks.ts";
import type { Context } from "./harness.ts";

/** Runs one check of a tier on the input's revision and records how it went. A check that throws is recorded as failed. */
export async function runCheck(check: string, input: ChecksInput, context: Context): Promise<CheckRecord> {
	try {
		const findings =
			check === "guardrails" ? await evaluateGuardrails(input, context) : await runStaticTool(check, input, context);
		return { name: check, status: "ran", findings: findings.length };
	} catch (error) {
		return { name: check, status: "failed", reason: error instanceof Error ? error.message : String(error) };
	}
}
