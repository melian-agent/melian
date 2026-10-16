import { describe, expect, it } from "vitest";
import { isFailoverError } from "../src/harness.ts";

describe("isFailoverError", () => {
	it.each([
		"GoUsageLimitError",
		"FreeUsageLimitError",
		"Monthly usage limit reached",
		"Enable available balance to continue",
		"insufficient_quota",
		"You are out of budget",
		"Quota exceeded for this project",
		"Check your billing details",
		"You have hit your ChatGPT usage limit (plus plan). Try again in ~5 min.",
		"Codex error: The usage limit has been reached",
		'{"error":{"code":"usage_limit_reached"}}',
		"billing_hard_limit_reached",
		"billing not active",
		"429 subscription_sharing_usage_limit_exceeded",
	])("moves on from the provider limit %j", (message) => {
		expect(isFailoverError(message)).toBe(true);
	});

	it("keeps a transient failure and an authentication failure moving on", () => {
		expect(isFailoverError("503 overloaded_error")).toBe(true);
		expect(isFailoverError("401 unauthorized")).toBe(true);
	});

	it("does not move on from a failure another model would not fix", () => {
		expect(isFailoverError("prompt is malformed")).toBe(false);
		expect(isFailoverError("400 invalid_request_error: billing must be an object")).toBe(false);
	});
});
