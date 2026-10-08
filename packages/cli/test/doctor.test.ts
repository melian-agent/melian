import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@melian-agent/core";
import * as githubProvider from "@melian-agent/github";
import { Sandbox } from "@melian-agent/pipeline";
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
		expect(result.trust).toContain(`policy origin/HEAD (${gitIn(repo, "rev-parse", "origin/HEAD").slice(0, 7)})`);
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
		writeFileSync(join(repo, "melian.yaml"), "trust: { writers: true }\n");
		gitIn(repo, "add", "melian.yaml");
		gitIn(repo, "commit", "--quiet", "-m", "trust writers");
		gitIn(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
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

	it("keeps waiting until the ten-second deadline", async () => {
		const state = github();
		const transport = fakeGitHub(state);
		const started = Promise.withResolvers<void>();
		let signal: AbortSignal | null | undefined;
		const fetch: typeof globalThis.fetch = (input, init) => {
			if (new URL(String(input)).pathname === "/user") {
				signal = init?.signal;
				started.resolve();
				return new Promise<Response>(() => {});
			}
			return transport(input, init);
		};
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const pending = run(state, fetch);
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await started.promise;
		await vi.advanceTimersByTimeAsync(9_999);
		expect(settled).toBe(false);
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		vi.useRealTimers();
		const result = await pending;
		expect(result.trust).toContain("GitHub read timed out after 10 seconds");
		expect(signal?.aborted).toBe(true);
	}, 30_000);

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
		expect(result.stdout).not.toMatch(/ {2}mutation\s/);
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

describe("doctor mutation testing", () => {
	// Whether the host has a sandbox is not what these tests are about, and a sandboxed run has none.
	beforeEach(() => {
		vi.spyOn(Sandbox, "detect").mockReturnValue({ backend: "seatbelt" } as Sandbox);
	});

	const line = (stdout: string) => stdout.split("\n").find((each) => / {2}mutation\s+/.test(each));
	const enable = () => writeFileSync(join(repo, "melian.yaml"), "static: { mutation: { enabled: true } }\n");

	it("warns that the check records a skip when it is on and the checkout has no Stryker, since Melian carries none", async () => {
		enable();
		const { status, stdout } = await run(github());
		expect(status).toBe(0);
		expect(line(stdout)).toMatch(
			/^warn {2}mutation\s+static\.mutation is on, but Stryker is not installed in the checkout/,
		);
		expect(line(stdout)).toContain("@stryker-mutator/core and @stryker-mutator/vitest-runner");
	});

	it("is ok when the checkout has a Stryker of its own", async () => {
		enable();
		mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
		writeFileSync(join(repo, "node_modules/.bin/stryker"), "#!/bin/sh\n");
		chmodSync(join(repo, "node_modules/.bin/stryker"), 0o755);
		const { stdout } = await run(github());
		expect(line(stdout)).toMatch(
			/^ok {4}mutation\s+static\.mutation runs Stryker from the checkout in a \w+ sandbox$/,
		);
	});

	it.each(["seatbelt", "bubblewrap"] as const)("names the %s sandbox it found", async (backend) => {
		enable();
		mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
		writeFileSync(join(repo, "node_modules/.bin/stryker"), "#!/bin/sh\n");
		chmodSync(join(repo, "node_modules/.bin/stryker"), 0o755);
		vi.spyOn(Sandbox, "detect").mockReturnValue({ backend } as Sandbox);
		const { stdout } = await run(github());
		expect(line(stdout)).toMatch(
			new RegExp(`^ok {4}mutation\\s+static\\.mutation runs Stryker from the checkout in a ${backend} sandbox$`),
		);
	});

	it("warns that the check runs nothing when the host offers no sandbox", async () => {
		enable();
		mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
		writeFileSync(join(repo, "node_modules/.bin/stryker"), "#!/bin/sh\n");
		chmodSync(join(repo, "node_modules/.bin/stryker"), 0o755);
		vi.spyOn(Sandbox, "detect").mockReturnValue(undefined);
		const { stdout } = await run(github());
		expect(line(stdout)).toMatch(/^warn {2}mutation\s+static\.mutation is on, but the host offers no sandbox/);
	});

	it("warns with the reason when the configuration cannot be read", async () => {
		writeFileSync(join(repo, "melian.yaml"), "static: { mutation: { enabled: 3 } }\n");
		const { stdout } = await run(github());
		expect(line(stdout)).toMatch(/^warn {2}mutation\s+\S/);
		expect(line(stdout)).not.toContain("static.mutation is on");
	});

	it("says nothing while the check is off", async () => {
		const { stdout } = await run(github());
		expect(line(stdout)).toBeUndefined();
	});
});

describe("doctor clone check", () => {
	let clone: string;
	let linked: string;

	beforeEach(() => {
		clone = realpathSync(mkdtempSync(join(tmpdir(), "melian-doctor-clone-")));
		gitIn(clone, "init", "--quiet", "--initial-branch=main");
		mkdirSync(join(clone, "bin"));
		linked = join(clone, "bin", "melian.js");
		writeFileSync(linked, "// shim\n");
	});

	afterEach(() => rmSync(clone, { recursive: true, force: true }));

	async function cloneLine(executable: string | undefined): Promise<string | undefined> {
		const { stdout } = await run(github(), undefined, executable === undefined ? {} : { executable });
		return stdout.split("\n").find((line) => / {2}clone\s+/.test(line));
	}

	function commit(): string {
		gitIn(clone, "add", "-A");
		gitIn(clone, "commit", "--quiet", "-m", "clone");
		return gitIn(clone, "rev-parse", "--short=12", "HEAD").trim();
	}

	it("prints the commit of a clean clone", async () => {
		const sha = commit();
		expect(await cloneLine(linked)).toBe(`ok    clone       ${clone} at ${sha}, tree clean`);
	});

	it("warns when a tracked file is edited", async () => {
		const sha = commit();
		writeFileSync(linked, "// edited\n");
		expect(await cloneLine(linked)).toContain(`${clone} at ${sha}, tree dirty`);
		expect(await cloneLine(linked)).toMatch(/^warn /);
	});

	it("warns when config hides an untracked file", async () => {
		commit();
		gitIn(clone, "config", "status.showUntrackedFiles", "no");
		writeFileSync(join(clone, "new.ts"), "");
		expect(await cloneLine(linked)).toMatch(/^warn .*tree dirty/);
	});

	it.each(["tracked", "untracked"])("warns when config hides a submodule's %s edit", async (kind) => {
		const source = join(home, "submodule-source");
		mkdirSync(source);
		gitIn(source, "init", "--quiet", "--initial-branch=main");
		writeFileSync(join(source, "tracked.ts"), "original\n");
		gitIn(source, "add", "-A");
		gitIn(source, "commit", "--quiet", "-m", "submodule");
		gitIn(clone, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", source, "sub");
		const sha = commit();
		gitIn(clone, "config", "submodule.sub.ignore", "all");
		expect(await cloneLine(linked)).toContain(`${clone} at ${sha}, tree clean`);
		writeFileSync(join(clone, "sub", kind === "tracked" ? "tracked.ts" : "new.ts"), "edited\n");
		expect(await cloneLine(linked)).toMatch(/^warn .*tree dirty/);
	});

	it("follows a symlink to the clone", async () => {
		const sha = commit();
		const link = join(home, "melian");
		symlinkSync(linked, link);
		expect(await cloneLine(link)).toContain(`${clone} at ${sha}, tree clean`);
	});

	it("warns for a clone with no commit", async () => {
		expect(await cloneLine(linked)).toMatch(/^warn .*with no commit/);
	});

	it("warns when git cannot read the tree", async () => {
		const sha = commit();
		writeFileSync(join(clone, ".git", "index"), "not an index");
		expect(await cloneLine(linked)).toMatch(new RegExp(`^warn .*at ${sha}; git could not read its tree`));
	});

	it("prints nothing for an install under node_modules", async () => {
		const installed = join(clone, "node_modules", "@melian-agent", "cli", "bin");
		mkdirSync(installed, { recursive: true });
		writeFileSync(join(installed, "melian.js"), "// shim\n");
		commit();
		expect(await cloneLine(join(installed, "melian.js"))).toBeUndefined();
	});

	it("prints nothing when the executable is outside a clone", async () => {
		const outside = join(home, "melian.js");
		writeFileSync(outside, "");
		expect(await cloneLine(outside)).toBeUndefined();
	});

	it("prints nothing without an executable", async () => {
		expect(await cloneLine(undefined)).toBeUndefined();
	});
});
