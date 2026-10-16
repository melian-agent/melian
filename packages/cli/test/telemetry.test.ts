import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Changeset } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	ReviewHarness,
	StageTelemetry,
	TelemetryReader,
} from "@melian-agent/pipeline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commit, createRepository, removeRepository } from "../../pipeline/test/fixtures/repo.ts";
import { type Io, telemetry } from "../src/commands.ts";
import { main } from "../src/main.ts";
import * as repository from "../src/repository.ts";

let repo: string;
let changeset: Changeset;
let io: Io & {
	stdout: ReturnType<typeof vi.fn<(text: string) => void>>;
	stderr: ReturnType<typeof vi.fn<(text: string) => void>>;
};
let storage: ReturnType<typeof createMemoryStorage>;
let timings: StageTelemetry;
let path: string;
beforeEach(async () => {
	repo = createRepository();
	commit(repo, { "a.ts": "export const a = 1;\n", "melian.yaml": "tiers:\n  fast: [guardrails]\n  full: [fast]\n" });
	commit(repo, { "a.ts": "export const a = 2;\n" });
	changeset = await Changeset.resolve(repo, "main...HEAD");
	const script = join(repo, "script.json");
	writeFileSync(script, "{}");
	io = {
		cwd: repo,
		env: { MELIAN_TEST_SCRIPT: script, XDG_CONFIG_HOME: join(repo, "config"), PI_CODING_AGENT_DIR: join(repo, "pi") },
		color: false,
		stdout: vi.fn<(text: string) => void>(),
		stderr: vi.fn<(text: string) => void>(),
	};
	path = join(repo, "state.sqlite");
	writeFileSync(path, "");
	storage = createMemoryStorage();
	timings = new StageTelemetry(`${changeset.revision.base}..${changeset.revision.head}`, [
		{
			id: "task:1",
			task: 1,
			name: "melian.check",
			subject: "guardrails",
			outcome: "completed",
			startedAt: 100,
			endedAt: 125,
			durationMs: 25,
			timing: "available",
			reused: false,
			resumed: false,
		},
	]);
	vi.spyOn(repository, "storagePath").mockResolvedValue(path);
	vi.spyOn(repository, "openStorage").mockResolvedValue(storage);
	vi.spyOn(TelemetryReader.prototype, "read").mockResolvedValue(timings);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await storage.close(context);
	removeRepository(repo);
});

it.each([false, true])("reads detached telemetry in process (json=%s)", async (json) => {
	const close = vi.spyOn(storage, "close");
	expect(await main(["telemetry", "main...HEAD", ...(json ? ["--json"] : [])], io)).toBe(0);
	expect(TelemetryReader.prototype.read).toHaveBeenCalledExactlyOnceWith(timings.revision);
	expect(io.stdout).toHaveBeenCalledExactlyOnceWith(
		json ? `${JSON.stringify(timings.toJSON(), null, 2)}\n` : timings.render(),
	);
	expect(io.stderr).not.toHaveBeenCalled();
	expect(close).toHaveBeenCalledTimes(1);
});

it("refuses missing telemetry storage before opening it", async () => {
	unlinkSync(path);
	await expect(telemetry(io, "main...HEAD", { json: false })).rejects.toThrow(
		"No stage telemetry is stored for this revision.",
	);
	expect(repository.openStorage).not.toHaveBeenCalled();
	expect(TelemetryReader.prototype.read).not.toHaveBeenCalled();
	expect(io.stdout).not.toHaveBeenCalled();
});

it("refuses an empty timing result and closes its storage", async () => {
	vi.mocked(TelemetryReader.prototype.read).mockResolvedValue(new StageTelemetry(timings.revision, []));
	const close = vi.spyOn(storage, "close");
	await expect(telemetry(io, "main...HEAD", { json: false })).rejects.toThrow(
		"No stage telemetry is stored for this revision.",
	);
	expect(io.stdout).not.toHaveBeenCalled();
	expect(close).toHaveBeenCalledTimes(1);
});

it.each([false, true])("closes a failed detached read without review JSON (json=%s)", async (json) => {
	vi.mocked(TelemetryReader.prototype.read).mockRejectedValue(new Error("unreadable\u001b[2J"));
	const close = vi.spyOn(storage, "close");
	expect(await main(["telemetry", "main...HEAD", ...(json ? ["--json"] : [])], io)).toBe(1);
	expect(io.stdout).not.toHaveBeenCalled();
	expect(io.stderr).toHaveBeenCalledExactlyOnceWith("melian: unreadable\\u001b[2J\n");
	expect(close).toHaveBeenCalledTimes(1);
});

it.each([{ targets: [] }, { targets: ["main", "HEAD"] }])(
	"requires exactly one telemetry target: %j",
	async ({ targets }) => {
		expect(await main(["telemetry", ...targets], io)).toBe(64);
		expect(io.stdout).not.toHaveBeenCalled();
		expect(repository.openStorage).not.toHaveBeenCalled();
	},
);

it.each([false, true])("prints the slowest stages for an in-process review (failed=%s)", async (failed) => {
	if (failed) vi.spyOn(ReviewHarness.prototype, "resumedProviders").mockRejectedValue(new Error("review stopped"));
	expect(await main(["review", "main...HEAD", "--json"], io), JSON.stringify(io.stderr.mock.calls)).toBe(
		failed ? 2 : 0,
	);
	expect(io.stderr.mock.calls.filter(([line]) => String(line).startsWith("melian: Slowest stages:"))).toEqual([
		[timings.slowest()],
	]);
	expect(JSON.parse(io.stdout.mock.calls[0]![0])).toMatchObject({ telemetry: timings.toJSON() });
	if (failed) expect(JSON.parse(io.stdout.mock.calls[0]![0])).toHaveProperty("error.message", "review stopped");
});
