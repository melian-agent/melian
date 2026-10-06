import { visibleText } from "@melian-agent/core";
import { ToolProvisioning } from "@melian-agent/pipeline";
import type { Io } from "./commands.ts";
import { git, stateDirectory } from "./repository.ts";

type ToolReadiness = { name: string; version: string; state: "verified" | "not-fetched" | "mismatch"; detail: string };

export class ToolInventory {
	readonly #tools: ToolProvisioning;
	private constructor(tools: ToolProvisioning) {
		this.#tools = tools;
	}
	static async open(
		cwd: string,
		environment: NodeJS.ProcessEnv,
		provisioning?: ToolProvisioning,
	): Promise<ToolInventory> {
		const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
		return new ToolInventory(
			provisioning ?? (await ToolProvisioning.open(root, { root: await stateDirectory(root, environment) })),
		);
	}
	async readiness(): Promise<ToolReadiness[]> {
		const results: ToolReadiness[] = [];
		for (const name of Object.keys(this.#tools.manifest.toJSON().tools)) {
			const tool = this.#tools.tool(name);
			try {
				const state = await this.#tools.cache.readiness(tool, this.#tools.platform);
				results.push({
					name,
					version: tool.version,
					state,
					detail:
						state === "verified"
							? "materialised and verified"
							: state === "not-fetched"
								? "not yet fetched"
								: "manifest mismatch",
				});
			} catch (error) {
				results.push({
					name,
					version: tool.version,
					state: "mismatch",
					detail: `manifest mismatch: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
		return results;
	}
	async fetch(name: string): Promise<string> {
		return this.#tools.binary(name);
	}
	async render(): Promise<string> {
		return (await this.readiness())
			.map(
				(tool) =>
					`${visibleText(tool.name)}@${visibleText(tool.version)}  ${this.#tools.platform}  ${visibleText(tool.detail)}\n`,
			)
			.join("");
	}
}

export async function tools(io: Io, name?: string): Promise<number> {
	const inventory = await ToolInventory.open(io.cwd, io.env);
	io.stdout(name === undefined ? await inventory.render() : `${visibleText(await inventory.fetch(name))}\n`);
	return 0;
}
