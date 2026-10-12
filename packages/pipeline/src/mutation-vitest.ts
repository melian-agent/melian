import { resolve } from "node:path";

interface VitestListing {
	config: { related?: string[] };
	getRelevantTestSpecifications(): Promise<readonly { moduleId: string }[]>;
	close(): Promise<void>;
}

interface MutationAttempt {
	readonly code: number;
	readonly report?: string;
}

export class MutationVitest {
	readonly notes: string[];
	readonly #tests?: string[];

	private constructor(note: string, tests?: string[]) {
		this.notes = [note];
		this.#tests = tests;
	}

	static whole(reason: string): MutationVitest {
		return new MutationVitest(`Mutation tests use the whole suite: ${reason}.`);
	}

	static async open(start: () => Promise<VitestListing>, changed: readonly string[]): Promise<MutationVitest> {
		try {
			const vitest = await start();
			try {
				vitest.config.related = undefined;
				const candidates = await vitest.getRelevantTestSpecifications();
				const tests = new Set<string>();
				for (const path of changed) {
					vitest.config.related = [resolve(path)];
					const related = await vitest.getRelevantTestSpecifications();
					if (related.length === 0) return MutationVitest.whole(`Vitest related no test to ${path}`);
					for (const test of related) tests.add(test.moduleId);
				}
				if (candidates.every((test) => tests.has(test.moduleId)))
					return MutationVitest.whole("Vitest related every candidate test");
				return new MutationVitest(`Mutation tests use ${tests.size} related test file(s) selected by Vitest.`, [
					...tests,
				]);
			} finally {
				await vitest.close();
			}
		} catch (error) {
			return MutationVitest.whole(`Vitest listing failed: ${String(error)}`);
		}
	}

	async execute(run: (tests?: readonly string[], fresh?: true) => Promise<MutationAttempt>): Promise<MutationAttempt> {
		if (this.#tests === undefined) return run(this.#tests);
		let reason: string;
		try {
			const result = await run(this.#tests);
			if (result.code !== 0) throw new Error(`related run exited ${result.code}`);
			const report = JSON.parse(result.report!) as { files: Record<string, { mutants: { status: string }[] }> };
			if (!Object.values(report.files).some((file) => file.mutants.some((mutant) => mutant.status === "NoCoverage")))
				return result;
			reason = "Stryker reported NoCoverage in the related run";
		} catch (error) {
			reason = `related result could not be read: ${String(error)}`;
		}
		this.notes.push(`Mutation tests use the whole suite: ${reason}.`);
		return run(undefined, true);
	}
}

export const mutationVitestModule = import.meta.url;
export const mutationSelectionVersion = "vitest-selection@2";
