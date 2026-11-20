import { describe, expect, it } from "vitest";
import { isContentRefusal, isFailoverError, isProviderLimit } from "../src/harness.ts";

const limits = [
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
];

describe("isFailoverError", () => {
	it.each(limits)("moves on from the provider limit %j", (message) => {
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

describe("isContentRefusal", () => {
	it.each([
		// Codex's refusal of the probing planner on pull requests #532 and #576, on 2026-11-20.
		"Codex error: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. If you think this is an error, contact us.",
		"Provider stopped with: sensitive",
		"Provider stopped with: content_filtered",
		"Provider stopped with: SAFETY",
		"Provider stopped with: PROHIBITED_CONTENT",
		"Provider stopped with: BLOCKLIST",
		"Provider stopped with: SPII",
		"Provider finish_reason: content_filter",
		"Response incomplete: content_filter",
		"The model refused to complete the request",
	])("moves on from the content filter's refusal %j", (message) => {
		expect({ refusal: isContentRefusal(message), failover: isFailoverError(message) }).toEqual({
			refusal: true,
			failover: true,
		});
	});

	it("keeps a provider limit a limit, not a refusal", () => {
		const limit = "Codex error: The usage limit has been reached";
		expect({ refusal: isContentRefusal(limit), failover: isFailoverError(limit) }).toEqual({
			refusal: false,
			failover: true,
		});
	});

	it.each([
		// A malformed request, and errors that only quote text naming a filter.
		"Codex error: Invalid value for 'input': this content was flagged as malformed",
		"400 invalid_request_error: This content was flagged for possible cybersecurity risk.",
		"Error Code 400: Codex error: This content was flagged for possible cybersecurity risk.",
		// A model's own answer that mentions a flag, should one ever reach the classifier.
		"I flagged this content for possible cybersecurity risk in src/probe.ts.",
		// Each fixed message with more after it, as no adapter builds.
		"Provider stopped with: sensitive data in the request",
		"Provider stopped with: SAFETY_SETTINGS_INVALID",
		"Provider finish_reason: content_filter_config_missing",
		"Response incomplete: content_filter misconfigured",
		"The model refused to complete the request: tool schema invalid",
		// A stop that is no content filter, and a guardrail the account set.
		"Provider stopped with: RECITATION",
		"Provider stopped with: guardrail_intervened",
	])("does not read %j as a refusal, nor move on from it", (message) => {
		expect({ refusal: isContentRefusal(message), failover: isFailoverError(message) }).toEqual({
			refusal: false,
			failover: false,
		});
	});
});

describe("isProviderLimit", () => {
	it.each(limits)("reads %j as a provider limit", (message) => {
		expect(isProviderLimit(message)).toBe(true);
	});

	it("reads a transient failure, an authentication failure and a malformed request as no limit", () => {
		expect(isProviderLimit("503 overloaded_error")).toBe(false);
		expect(isProviderLimit("401 unauthorized")).toBe(false);
		expect(isProviderLimit("400 invalid_request_error: billing must be an object")).toBe(false);
	});
});
