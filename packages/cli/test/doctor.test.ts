import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv } from "../../core/test/fixtures/repo.ts";
import { fakeGitHub, fakeState } from "../../github/test/fixtures/fake-github.ts";
import { doctor } from "../src/doctor.ts";

let repo: string;
let home: string;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = mkdtempSync(join(tmpdir(), "melian-doctor-trust-"));
	home = mkdtempSync(join(tmpdir(), "melian-doctor-home-"));
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	writeFileSync(join(repo, "melian.yaml"), "trust: { writers: false }\n");
	gitIn(repo, "add", "melian.yaml");
	gitIn(repo, "commit", "--quiet", "-m", "base policy");
	gitIn(repo, "remote", "add", "origin", "https://github.com/test/repo.git");
	gitIn(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
	gitIn(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

function github() {
	return fakeState(
		"test",
		"repo",
		{
			number: 7,
			title: "Review",
			base: { ref: "main", sha: "a".repeat(40) },
			head: { ref: "feature", sha: "b".repeat(40) },
		},
		{},
	);
}

async function run(state: ReturnType<typeof github>, fetch: typeof globalThis.fetch = fakeGitHub(state)) {
	let stdout = "";
	const status = await doctor(
		{
			cwd: repo,
			env: {
				...process.env,
				XDG_CONFIG_HOME: home,
				PI_CODING_AGENT_DIR: home,
				GITHUB_TOKEN: "test-token-never-printed",
			},
			stdout: (text) => {
				stdout += text;
			},
			stderr: () => {},
			color: false,
		},
		{ fetch },
	);
	return { status, stdout, trust: stdout.split("\n").find((line) => / {2}trust\s+/.test(line)) };
}

describe("doctor writer trust", () => {
	it("reads the committed default base despite head and worktree edits", async () => {
		gitIn(repo, "checkout", "--quiet", "-b", "feature");
		writeFileSync(join(repo, "melian.yaml"), "trust: { writers: true }\n");
		gitIn(repo, "add", "melian.yaml");
		gitIn(repo, "commit", "--quiet", "-m", "head policy");
		writeFileSync(
			join(repo, "melian.yaml"),
			"trust: { writers: true }\npublish: { walkthrough: { enabled: false } }\n",
		);
		const state = github();
		const result = await run(state);
		expect(result.status).toBe(0);
		expect(result.trust).toMatch(/^warn {2}trust\s+writers trusted: no; policy origin\/HEAD/);
		expect(result.trust).toContain("a trusted host must set the status; viewer melian-user (write)");
		expect(state.calls.filter(({ path }) => path === "/user")).toHaveLength(1);
		expect(state.calls.filter(({ path }) => path.endsWith("/permission"))).toHaveLength(1);
		expect(result.stdout).not.toContain("test-token-never-printed");
	});

	it.each(["admin", "maintain", "write", "triage", "read", "none"])(
		"reports %s permission without failing",
		async (permission) => {
			writeFileSync(join(repo, "melian.yaml"), "trust: { writers: true }\n");
			gitIn(repo, "add", "melian.yaml");
			gitIn(repo, "commit", "--quiet", "-m", "trust writers");
			gitIn(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
			const state = github();
			state.permissions = { [state.login]: permission };
			const result = await run(state);
			expect(result.status).toBe(0);
			expect(result.trust).toContain(`viewer melian-user (${permission})`);
			const writable = ["admin", "maintain", "write"].includes(permission);
			expect(result.trust).toMatch(writable ? /^ok / : /^warn /);
			if (!writable) expect(result.trust).toContain("melian publish cannot set a status here");
		},
	);

	it.each(["viewer", "permission"])("warns on a refused %s read", async (refusal) => {
		const state = github();
		state.failUser = refusal === "viewer";
		state.failPermission = refusal === "permission";
		const result = await run(state);
		expect(result.status).toBe(0);
		expect(result.trust).toMatch(/^warn /);
		expect(result.trust).toContain("(unknown); cannot establish whether melian publish can set a status here");
	});

	it.each(["viewer", "permission"])(
		"warns instead of hanging on a %s read",
		async (read) => {
			const state = github();
			const transport = fakeGitHub(state);
			const started = Promise.withResolvers<void>();
			let signal: AbortSignal | null | undefined;
			const fetch: typeof globalThis.fetch = (input, init) => {
				const path = new URL(String(input)).pathname;
				if (path === (read === "viewer" ? "/user" : `/repos/test/repo/collaborators/${state.login}/permission`)) {
					signal = init?.signal;
					started.resolve();
					return new Promise<Response>(() => {});
				}
				return transport(input, init);
			};
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const pending = run(state, fetch);
			await started.promise;
			await vi.advanceTimersByTimeAsync(10_000);
			vi.useRealTimers();
			const result = await pending;
			expect(result.status).toBe(0);
			expect(result.trust).toMatch(/^warn /);
			expect(result.trust).toContain("GitHub read timed out after 10 seconds; viewer permission is unknown");
			expect(signal?.aborted).toBe(true);
		},
		30_000,
	);

	it("prefers origin/main over a stale local main", async () => {
		gitIn(repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
		writeFileSync(join(repo, "melian.yaml"), "trust: { writers: true }\n");
		gitIn(repo, "add", "melian.yaml");
		gitIn(repo, "commit", "--quiet", "-m", "local policy");
		const state = github();
		state.permissions = { [state.login]: "write" };
		const result = await run(state);
		expect(result.status).toBe(0);
		expect(result.trust).toContain("writers trusted: no; policy origin/main");
	});

	it("warns that local main may be stale when no remote base ref exists", async () => {
		gitIn(repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
		gitIn(repo, "update-ref", "-d", "refs/remotes/origin/main");
		writeFileSync(join(repo, "melian.yaml"), "trust: { writers: true }\n");
		gitIn(repo, "add", "melian.yaml");
		gitIn(repo, "commit", "--quiet", "-m", "local policy");
		const state = github();
		state.permissions = { [state.login]: "write" };
		const result = await run(state);
		expect(result.status).toBe(0);
		expect(result.trust).toMatch(/^warn /);
		expect(result.trust).toContain("policy main");
		expect(result.trust).toContain("base policy may be stale; using local main");
	});

	it("warns when HEAD is the only committed policy available", async () => {
		gitIn(repo, "update-ref", "-d", "refs/remotes/origin/HEAD");
		gitIn(repo, "update-ref", "-d", "refs/remotes/origin/main");
		gitIn(repo, "branch", "-m", "feature");
		const result = await run(github());
		expect(result.status).toBe(0);
		expect(result.trust).toContain("base policy is unknown; using committed HEAD");
	});
});
