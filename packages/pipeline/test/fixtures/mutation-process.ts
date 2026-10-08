import { vi } from "vitest";
import { MutationProcess } from "../../src/mutation-process.ts";
export function fakeMutationProcesses(): void {
	vi.spyOn(MutationProcess.prototype, "execute").mockImplementation(async function (
		this: MutationProcess,
		command,
		environment,
	) {
		await this.run.input.mutationProcess?.started({
			control: "/nonexistent",
			supervisor: { pid: 2, start: "s" },
			root: { pid: 3, start: "s" },
		});
		try {
			return await this.run.shell(command, undefined, environment);
		} finally {
			await this.run.input.mutationProcess?.stopped();
		}
	});
}
