import { expect, it } from "vitest";
import { MutationStderr } from "../src/mutation-stderr.ts";

it.each([4096, 4097])("keeps the last 4096 stderr characters across chunks (%s)", (length) => {
	const stderr = new MutationStderr();
	stderr.append("x".repeat(length - 1));
	stderr.append("y");
	expect(stderr.read()).toBe("x".repeat(Math.min(length, 4096) - 1) + "y");
});
it.each([32, 33])("keeps the last 32 stderr lines (%s)", (length) => {
	const stderr = new MutationStderr();
	stderr.append(Array.from({ length }, (_, index) => String(index)).join("\n"));
	expect(stderr.read()).toBe(
		Array.from({ length: Math.min(length, 32) }, (_, index) => String(index + Math.max(0, length - 32))).join("\n"),
	);
});
