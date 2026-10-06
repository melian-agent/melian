import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@melian-agent/core";
import * as githubProvider from "@melian-agent/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv } from "../../core/test/fixtures/repo.ts";
import { fakeGitHub, fakeState } from "../../github/test/fixtures/fake-github.ts";
import type { Io } from "../src/commands.ts";
import { doctor } from "../src/doctor.ts";

let repo: string;
let home: string;

beforeEach(() => {
	const fallback = github();
	fallback.login = "global-viewer";
	vi.stubGlobal("fetch", fakeGitHub(fallback));
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
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
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

async function run(
	state: ReturnType<typeof github>,
	fetch: typeof globalThis.fetch = fakeGitHub(state),
	overrides: Partial<Io> = {},
	defaultTransport = false,
) {
	let stdout = "";
	const io: Io = {
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
		...overrides,
	};
	const status = defaultTransport ? await doctor(io) : await doctor(io, { fetch });
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
		expect(result.trust).toContain(`viewer ${refusal === "viewer" ? "unknown" : "melian-user"} (unknown)`);
		expect(state.calls.filter(({ path }) => path.endsWith("/permission"))).toHaveLength(refusal === "viewer" ? 0 : 1);
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

	it.each(["viewer", "permission"])(
		"bounds %s body parsing after response headers arrive",
		async (read) => {
			const state = github();
			const transport = fakeGitHub(state);
			const started = Promise.withResolvers<void>();
			let signal: AbortSignal | null | undefined;
			let body: ReadableStreamDefaultController<Uint8Array> | undefined;
			const fetch: typeof globalThis.fetch = (input, init) => {
				const path = new URL(String(input)).pathname;
				if (path === (read === "viewer" ? "/user" : `/repos/test/repo/collaborators/${state.login}/permission`)) {
					signal = init?.signal;
					return Promise.resolve(
						new Response(
							new ReadableStream<Uint8Array>({
								start(controller) {
									body = controller;
									started.resolve();
								},
							}),
							{ headers: { "content-type": "application/json" } },
						),
					);
				}
				return transport(input, init);
			};
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const pending = run(state, fetch);
				await started.promise;
				await vi.advanceTimersByTimeAsync(10_000);
				vi.useRealTimers();
				const result = await pending;
				expect(result.status).toBe(0);
				expect(result.trust).toMatch(/^warn /);
				expect(result.trust).toContain("GitHub read timed out after 10 seconds; viewer permission is unknown");
				expect(signal?.aborted).toBe(true);
			} finally {
				body?.close();
			}
		},
		5_000,
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
		writeFileSync(join(repo, "melian.yaml"), "trust: { writers: true }\n");
		gitIn(repo, "add", "melian.yaml");
		gitIn(repo, "commit", "--quiet", "-m", "trusted HEAD policy");
		gitIn(repo, "update-ref", "-d", "refs/remotes/origin/HEAD");
		gitIn(repo, "update-ref", "-d", "refs/remotes/origin/main");
		gitIn(repo, "branch", "-m", "feature");
		const result = await run(github());
		expect(result.status).toBe(0);
		expect(result.trust).toMatch(/^warn /);
		expect(result.trust).toContain("base policy is unknown; using committed HEAD");
	});
});

describe("doctor trust boundaries", () => {
	it("warns outside a repository without reading GitHub", async () => {
		const state = github();
		const result = await run(state, undefined, { cwd: home });
		expect(result.status).toBe(0);
		expect(result.trust).toMatch(/^warn /);
		expect(result.trust).toContain("not inside a git repository; root policy is unknown");
		expect(state.calls).toEqual([]);
	});

	it("warns when no committed policy is available", async () => {
		gitIn(repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
		gitIn(repo, "update-ref", "-d", "refs/remotes/origin/main");
		gitIn(repo, "update-ref", "-d", "refs/heads/main");
		const state = github();
		const result = await run(state);
		expect(result.trust).toMatch(/^warn /);
		expect(result.trust).toContain("no committed root policy is available");
		expect(state.calls).toEqual([]);
	});

	it.each([new Error("failed\n\u001b[31m"), "failed\n\u001b[31m"])(
		"renders policy failures as visible warning text: %s",
		async (failure) => {
			vi.spyOn(core, "loadConfig").mockRejectedValueOnce(failure);
			const state = github();
			const result = await run(state);
			expect(result.status).toBe(0);
			expect(result.trust).toMatch(/^warn /);
			expect(result.trust).toContain("failed\\u000a\\u001b[31m");
			expect(result.trust).not.toContain("\u001b");
			expect(state.calls).toEqual([]);
		},
	);

	it("warns about a missing GitHub token without reading viewer identity", async () => {
		vi.spyOn(githubProvider, "resolveGitHubToken").mockResolvedValueOnce(undefined);
		const state = github();
		const result = await run(state);
		expect(result.trust).toMatch(/^warn /);
		expect(result.trust).toContain("; no GitHub token");
		expect(state.calls).toEqual([]);
	});

	it.each(["missing", "non-GitHub"])("warns about a %s origin without reading viewer identity", async (kind) => {
		if (kind === "missing") gitIn(repo, "remote", "remove", "origin");
		else gitIn(repo, "config", "remote.origin.url", "https://example.invalid/test/repo.git");
		const state = github();
		const result = await run(state);
		expect(result.trust).toMatch(/^warn /);
		expect(result.trust).toContain("no GitHub origin; viewer permission is unknown");
		expect(state.calls).toEqual([]);
	});

	it("uses the global transport when options are omitted", async () => {
		const state = github();
		vi.stubGlobal("fetch", fakeGitHub(state));
		const result = await run(state, undefined, {}, true);
		expect(result.trust).toContain("viewer melian-user (write)");
		expect(state.calls.filter(({ path }) => path === "/user")).toHaveLength(1);
	});

	it("escapes viewer control characters", async () => {
		const state = github();
		state.login = "viewer\n\u001b[31m";
		const result = await run(state);
		expect(result.trust).toContain("viewer viewer\\u000a\\u001b[31m (write)");
		expect(result.trust).not.toContain("\u001b");
	});

	it("clears the deadline after successful response parsing", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const result = await run(github());
		expect(result.trust).toContain("viewer melian-user (write)");
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["deadline", "caller"])(
		"combines a caller signal with the %s abort",
		async (trigger) => {
			const state = github();
			const upstream = new AbortController();
			const create = githubProvider.createGitHubProvider;
			vi.spyOn(githubProvider, "createGitHubProvider").mockImplementation((options) =>
				create({
					...options,
					fetch: (input, init) => options.fetch!(input, { ...init, signal: upstream.signal }),
				}),
			);
			const started = Promise.withResolvers<void>();
			let signal: AbortSignal | null | undefined;
			const fetch: typeof globalThis.fetch = (_input, init) => {
				signal = init?.signal;
				started.resolve();
				return new Promise<Response>(() => {});
			};
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const pending = run(state, fetch);
			try {
				await started.promise;
				if (trigger === "caller") {
					upstream.abort();
					expect(signal?.aborted).toBe(true);
				}
				await vi.advanceTimersByTimeAsync(10_000);
				vi.useRealTimers();
				const result = await pending;
				expect(result.trust).toContain("GitHub read timed out after 10 seconds");
				expect(signal?.aborted).toBe(true);
			} finally {
				if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(10_000);
				vi.useRealTimers();
				await pending;
			}
		},
		5_000,
	);
});
