import type { ProberRecord, StageTelemetry } from "@melian-agent/pipeline";

export class GoldenRunError extends Error {
	readonly code = "runFailed";
	readonly telemetry: StageTelemetry;
	readonly probers: Readonly<Record<string, ProberRecord>>;

	constructor(cause: unknown, telemetry: StageTelemetry, probers: Readonly<Record<string, ProberRecord>> = {}) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.telemetry = telemetry;
		this.probers = probers;
	}
}
