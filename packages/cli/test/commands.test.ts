import { fileURLToPath } from "node:url";
import { Adjudication, Changeset, defaultConfig, Finding, type StoredPlan } from "@melian-agent/core";
import { backgroundContext as context, createMemoryStorage, Round, RoundReader } from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findings, gitAuthor, type Io, PublicationAttestations, StoredReview } from "../src/commands.ts";
import * as repository from "../src/repository.ts";

afterEach(() => vi.restoreAllMocks());

it("renders no attestation without dismissals and names absent legacy metadata", () => {
	const empty = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig }).adjudicate();
	expect(
		new PublicationAttestations([{ revision: "base..head", round: 1, dismissals: empty.dismissals() }]).render(),
	).toBe("");
	const legacy = Finding.create({
		rule: "unsafe",
		file: "src/a.ts",
		startLine: 1,
		snippet: "unsafe()",
		occurrence: 0,
		cause: "introduced",
		severity: "P2",
		status: "dismissed",
		source: { check: "static.example" },
		message: "Unsafe",
		explanation: { what: "Unsafe", whyHere: "New", whatToDo: "Validate" },
	});
	const verdict = new Adjudication({
		findings: [legacy],
		manifest: [],
		checks: [],
		config: defaultConfig,
	}).adjudicate();
	expect(
		new PublicationAttestations([{ revision: "base..head", round: 1, dismissals: verdict.dismissals() }]).render(),
	).toBe(
		`Attested dismissals:\n  Revision base..head, round 1\n  ${legacy.id} unsafe in src/a.ts: by unknown at unknown: No reason stored.\n`,
	);
});

describe("git author errors", () => {
	it("names dismissal by default when git has no author", async () => {
		const git = vi.spyOn(repository, "git").mockRejectedValue(new Error("identity unavailable"));

		await expect(gitAuthor("/unused")).rejects.toMatchObject({
			name: "CliError",
			message:
				"Melian records who dismissed a finding as the git author, and git has none: identity unavailable; set user.name and user.email",
		});
		expect(git).toHaveBeenCalledExactlyOnceWith("/unused", ["var", "GIT_AUTHOR_IDENT"]);
	});

	it("names the hand match when git has no author", async () => {
		vi.spyOn(repository, "git").mockRejectedValue(new Error("identity unavailable"));

		await expect(gitAuthor("/unused", "matched a finding by hand")).rejects.toMatchObject({
			name: "CliError",
			message:
				"Melian records who matched a finding by hand as the git author, and git has none: identity unavailable; set user.name and user.email",
		});
	});
});

describe("stored round findings", () => {
	const changesetId = "range-0123456789abcdef";
	const roundId = `${changesetId}.r1`;
	let storage: ReturnType<typeof createMemoryStorage>;
	let io: Io & {
		stdout: ReturnType<typeof vi.fn<(text: string) => void>>;
		stderr: ReturnType<typeof vi.fn<(text: string) => void>>;
	};
	let verdict: ReturnType<Adjudication["adjudicate"]>;
	const options = { open: false, all: false, json: false };

	beforeEach(() => {
		storage = createMemoryStorage();
		io = {
			cwd: "/round-test",
			env: {},
			color: false,
			stdout: vi.fn<(text: string) => void>(),
			stderr: vi.fn<(text: string) => void>(),
		};
		vi.spyOn(repository, "storagePath").mockImplementation(async (root, id) => {
			expect(root).toBe(io.cwd);
			expect(id).toBe(changesetId);
			return fileURLToPath(import.meta.url);
		});
		vi.spyOn(repository, "openStorage").mockResolvedValue(storage);
		vi.spyOn(storage, "close");
		vi.spyOn(repository, "git").mockImplementation(async (root, args) => {
			expect(root).toBe(io.cwd);
			expect(args).toEqual(["rev-parse", "--show-toplevel"]);
			return io.cwd;
		});
		const finding = Finding.create({
			rule: "unsafe",
			file: "src/a.ts",
			startLine: 1,
			snippet: "unsafe()",
			occurrence: 0,
			cause: "introduced",
			severity: "P2",
			source: { check: "static.example" },
			message: "Unsafe",
			explanation: { what: "Unsafe", whyHere: "New", whatToDo: "Validate" },
		});
		verdict = new Adjudication({ findings: [finding], manifest: [], checks: [], config: defaultConfig }).adjudicate();
		vi.spyOn(RoundReader.prototype, "read").mockImplementation(async (id) => {
			expect(id).toBe(changesetId);
			return [new Round(roundId, { base: "base", head: "head", tasks: [], verdict: verdict.toJSON() })];
		});
	});

	afterEach(async () => {
		await storage.close(context);
	});

	it("prints IDs and resolution sources from a round without provenance", async () => {
		expect(await findings(io, "", { ...options, round: roundId })).toBe(0);
		const text = io.stdout.mock.calls[0]![0] as string;
		expect(text).toContain(verdict.attention()[0]!.id);
		expect(text).toContain("Decided by: resolution.P2, the table");
		expect(io.stderr).not.toHaveBeenCalled();
		expect(storage.close).toHaveBeenCalledExactlyOnceWith(context);
	});

	it.each([false, true])("omits agent instructions from historical text (open=%s)", async (open) => {
		expect(await findings(io, "", { ...options, open, round: roundId })).toBe(0);
		const text = io.stdout.mock.calls.map(([text]) => text).join("");
		expect(text).toContain(verdict.attention()[0]!.id);
		expect(text).not.toContain("Check each open finding against the code.");
		expect(text).not.toContain("<quoted-");
		expect(text).not.toContain("melian dismiss");
	});

	it("reports a missing round with the CLI error and closes storage", async () => {
		await expect(findings(io, "", { ...options, round: `${changesetId}.r2` })).rejects.toMatchObject({
			name: "CliError",
			message: `Melian has no decided round ${changesetId}.r2`,
		});
		expect(storage.close).toHaveBeenCalledExactlyOnceWith(context);
	});

	it("rejects a prefix before the changeset ID before reading git or storage", async () => {
		const id = `prefix-${roundId}`;
		await expect(findings(io, "", { ...options, round: id })).rejects.toMatchObject({
			name: "CliError",
			message: `invalid round ID ${id}`,
		});
		expect(repository.git).not.toHaveBeenCalled();
		expect(repository.openStorage).not.toHaveBeenCalled();
	});

	it.each([
		`${roundId}-suffix`,
		"range-a.r1",
		"pull-a.r1",
		`${changesetId}.k0`,
		`${changesetId}.r0`,
		`${changesetId}.r1x`,
	])("rejects malformed round ID %s before reading the repository", async (id) => {
		await expect(findings(io, "", { ...options, round: id })).rejects.toMatchObject({
			name: "CliError",
			message: `invalid round ID ${id}`,
		});
		expect(repository.git).not.toHaveBeenCalled();
	});

	it.each([roundId, `${changesetId}.r123`, `${changesetId}.k0123456789abcdef`, "pull-0123456789abcdef.r1"])(
		"accepts the complete round ID %s",
		async (id) => {
			vi.spyOn(repository, "git").mockRejectedValue(new Error("valid round reached repository"));
			await expect(findings(io, "", { ...options, round: id })).rejects.toThrow("valid round reached repository");
			expect(repository.git).toHaveBeenCalledExactlyOnceWith(io.cwd, ["rev-parse", "--show-toplevel"]);
		},
	);

	it("prints each plan warning once without a trailing blank warning", async () => {
		const plan: StoredPlan = {
			tiers: [
				{ tier: "heavy", status: "unrouted", models: [] },
				{ tier: "verifier", status: "routed", models: [{ model: "test/verifier", credential: "test" }] },
			],
			lenses: [{ name: "correctness", levels: [{ level: "careful", tier: "heavy" }] }],
		};
		vi.spyOn(RoundReader.prototype, "read").mockResolvedValue([
			new Round(roundId, {
				base: "base",
				head: "head",
				tasks: [],
				verdict: verdict.toJSON(),
				provenance: { kind: "range", policy: "config", manifest: [], lenses: [], plan },
			}),
		]);
		await findings(io, "", { ...options, round: roundId });
		expect(io.stderr.mock.calls).toEqual([
			[
				"melian: Plan: no model for heavy, for correctness; set models.heavy.model in melian.local.yaml, or pass --model to review\n",
			],
		]);
	});

	it("lists legacy dates without asking git for minted heads and closes storage", async () => {
		const changeset = Changeset.from({
			kind: "range",
			id: changesetId,
			repoRoot: io.cwd,
			spec: { base: "main", head: "feature", mode: "threeDot" },
			revision: { base: "base", head: "head", files: [], policyFiles: [] },
		});
		vi.spyOn(StoredReview, "open").mockResolvedValue({
			changeset,
			argument: "main...feature",
			missing: () => new repository.CliError("missing"),
		});
		vi.spyOn(repository, "git").mockImplementation(async (root, args) => {
			expect(root).toBe(io.cwd);
			expect(args).toEqual(["show", "-s", "--format=%ct", "legacy-head", "--"]);
			return "1";
		});
		vi.spyOn(RoundReader.prototype, "read").mockResolvedValue([
			new Round(roundId, { base: "base", head: "minted-head", tasks: [], mintedAt: "2026-10-18T01:00:00Z" }),
			new Round(`${changesetId}.k0123456789abcdef`, { base: "base", head: "legacy-head", tasks: [] }),
		]);
		await findings(io, "main...feature", { ...options, rounds: true, json: true });
		expect(repository.git).toHaveBeenCalledTimes(1);
		expect(JSON.parse(io.stdout.mock.calls[0]![0] as string).map((round: { head: string }) => round.head)).toEqual([
			"legacy-head",
			"minted-head",
		]);
		expect(storage.close).toHaveBeenCalledExactlyOnceWith(context);
	});
});
