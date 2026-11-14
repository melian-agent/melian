import { expect, it } from "vitest";
import { contextOverflowed } from "../src/models.ts";

it.each([
	["Anthropic's error for a prompt over the window", "prompt is too long: 250000 tokens > 200000 maximum", true],
	[
		"OpenAI's error, inside a lens's record of the models it tried",
		"tried a, b; the last said: Your input exceeds the context window of this model",
		true,
	],
	["a rate limit that names tokens", "Rate limit: too many tokens per minute", false],
	["a network failure", "fetch failed", false],
])("reads %s as a context overflow only when it is one", (_name, text, overflowed) => {
	expect(contextOverflowed(text)).toBe(overflowed);
});
