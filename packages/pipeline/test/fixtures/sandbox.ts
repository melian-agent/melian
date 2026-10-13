import { tmpdir } from "node:os";
import { vi } from "vitest";
import { backgroundContext, createNodeExecutionEnv } from "../../src/harness.ts";
import { Sandbox } from "../../src/sandbox.ts";

// A stand-in for the host's sandbox that confines nothing. A fake tool that records its calls outside the run's scratch
// directory needs it, since the real sandbox would not let it write there; the tests of the sandbox itself use the
// host's.
export const unconfinedSandbox = {
	backend: "seatbelt",
	profile: () => undefined,
	runtimeFailure: async () => undefined,
	environment: () => ({}),
	command: (inner: string, paths: { worktree: string }) =>
		`cd '${paths.worktree}' && /bin/bash -c '${inner.replaceAll("'", "'\\''")}'`,
} as unknown as Sandbox;

// The sandbox this host offers, probed once, for a test that runs only where there is one.
export const hostSandbox = await Sandbox.detect(createNodeExecutionEnv(tmpdir()), backgroundContext);

// For a test file whose fake tools must run: on a host with no sandbox a checkout's tool is never started, so such a
// file runs against the stand-in there, and against the host's own sandbox where it has one. Call it in `beforeEach`. A
// test of what a host with no sandbox does stubs `Sandbox.detect` with undefined itself.
export function standInWhereNoSandbox(): void {
	if (hostSandbox === undefined) vi.spyOn(Sandbox, "detect").mockResolvedValue(unconfinedSandbox);
}
