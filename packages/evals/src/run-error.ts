import type { StageTelemetry } from "@melian-agent/pipeline";

export class GoldenRunError extends Error {
	readonly code = "runFailed";
	readonly telemetry: StageTelemetry;

	constructor(cause: unknown, telemetry: StageTelemetry) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.telemetry = telemetry;
	}
}
