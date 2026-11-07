import { describe, expect, it } from "vitest";
import type { ReviewIndexState } from "../src/review-index.ts";
import { claimKey, VerificationWaves, type VerificationWavesState } from "../src/verification-waves.ts";

const state = (lensTask: number, waves: { task: number; candidates: { key: string; claims: string[] }[] }[]) =>
	({
		reviews: {
			r: { lensTask, ended: { a: { status: "done" } }, waves: waves.map((wave) => ({ ...wave, version: "v1" })) },
		},
	}) as VerificationWavesState;
const index = (task: number, verification?: number) =>
	({
		reviews: { r: { task, ...(verification === undefined ? {} : { verification: { task: verification } }) } },
	}) as unknown as ReviewIndexState;

describe("verification waves", () => {
	it("keys a claim by its finding and the producer that sighted it", () => {
		expect(claimKey({ id: "f1", source: { check: "lens.correctness", version: "3@careful" } } as never)).toBe(
			"f1 lens.correctness@3@careful",
		);
		expect(claimKey({ id: "f1", source: { check: "lens.correctness" } } as never)).toBe("f1 lens.correctness@");
	});

	it("reads an entry only for the lens task that started it", () => {
		const waves = state(7, [{ task: 11, candidates: [] }]);
		expect(VerificationWaves.of(waves, "r", 7).tasks()).toEqual([11]);
		expect(VerificationWaves.of(waves, "r", 7).ended()).toEqual({ a: { status: "done" } });
		expect(VerificationWaves.of(waves, "r", 8).tasks()).toEqual([]);
		expect(VerificationWaves.of(waves, "r", 8).ended()).toEqual({});
		expect(VerificationWaves.of(waves, "other", 7).tasks()).toEqual([]);
		expect(VerificationWaves.of(undefined, "r", 7).ended()).toEqual({});
	});

	it("owns the indexed verification and the waves of the indexed lens task, and nothing else", () => {
		const waves = state(7, [{ task: 11, candidates: [] }]);
		expect(VerificationWaves.owns(index(7, 20), waves, "r", 20)).toBe(true);
		expect(VerificationWaves.owns(index(7, 20), waves, "r", 11)).toBe(true);
		expect(VerificationWaves.owns(index(7), waves, "r", 11)).toBe(true);
		expect(VerificationWaves.owns(index(8, 20), waves, "r", 11)).toBe(false);
		expect(VerificationWaves.owns(index(7, 20), waves, "r", 12)).toBe(false);
		expect(VerificationWaves.owns(index(7, 20), waves, "r", undefined)).toBe(false);
		expect(VerificationWaves.owns({ reviews: {} } as unknown as ReviewIndexState, waves, "r", 11)).toBe(false);
		expect(VerificationWaves.owns(undefined, waves, "r", 11)).toBe(false);
	});

	it("stops owning a wave once a later wave verifies any of its claims", () => {
		const overlapping = state(7, [
			{
				task: 11,
				candidates: [
					{ key: "A", claims: ["x"] },
					{ key: "C", claims: ["z"] },
				],
			},
			{ task: 12, candidates: [{ key: "B", claims: ["w", "x"] }] },
		]);
		expect(VerificationWaves.owns(index(7, 20), overlapping, "r", 11)).toBe(false);
		expect(VerificationWaves.owns(index(7, 20), overlapping, "r", 12)).toBe(true);
		const apart = state(7, [
			{ task: 11, candidates: [{ key: "A", claims: ["x"] }] },
			{
				task: 12,
				candidates: [
					{ key: "C", claims: ["z"] },
					{ key: "D", claims: ["y"] },
				],
			},
		]);
		expect(VerificationWaves.owns(index(7, 20), apart, "r", 11)).toBe(true);
	});

	it("stands for a wave only under the verifier version that ran it", () => {
		const waves = {
			reviews: {
				r: {
					lensTask: 7,
					ended: {},
					waves: [{ task: 11, version: "v1", candidates: [{ key: "A", claims: ["x"] }] }],
				},
			},
		} as VerificationWavesState;
		expect(VerificationWaves.of(waves, "r", 7).standing("A", ["x"], "v1")).toBe(11);
		expect(VerificationWaves.of(waves, "r", 7).standing("A", ["x"], "v2")).toBeUndefined();
	});

	it("stands for a candidate's latest wave until a later wave verifies one of its claims in another candidate", () => {
		const waves = state(7, [
			{ task: 11, candidates: [{ key: "A", claims: ["x"] }] },
			{ task: 12, candidates: [{ key: "C", claims: ["z"] }] },
		]);
		expect(VerificationWaves.of(waves, "r", 7).standing("A", ["x"], "v1")).toBe(11);
		const joined = state(7, [
			{ task: 11, candidates: [{ key: "A", claims: ["x"] }] },
			{
				task: 12,
				candidates: [
					{ key: "C", claims: ["z"] },
					{ key: "B", claims: ["x", "y"] },
				],
			},
		]);
		expect(VerificationWaves.of(joined, "r", 7).standing("A", ["x"], "v1")).toBeUndefined();
		expect(VerificationWaves.of(joined, "r", 7).standing("B", ["x", "y"], "v1")).toBe(12);
		expect(VerificationWaves.of(joined, "r", 7).standing("D", ["w"], "v1")).toBeUndefined();
		expect(VerificationWaves.of(undefined, "r", 7).standing("A", ["x"], "v1")).toBeUndefined();
	});
});
