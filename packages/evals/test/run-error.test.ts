import { StageTelemetry } from "@melian-agent/pipeline";
import { expect, it } from "vitest";
import { GoldenRunError } from "../src/run-error.ts";

it.each([new Error("provider failed"), "provider refused"])(
	"retains the original cause %s with detached telemetry",
	(cause) => {
		const telemetry = new StageTelemetry("base..head", []);
		const error = new GoldenRunError(cause, telemetry);
		expect(error.cause).toBe(cause);
		expect(error.message).toBe(cause instanceof Error ? cause.message : cause);
		expect(error.telemetry).toBe(telemetry);
	},
);
