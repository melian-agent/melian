import { tmpdir } from "node:os";
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

// The note a static run of `tool` adds on a host with no sandbox, and nothing where the host has one.
export function unconfinedNotes(tool: string): string[] {
	return hostSandbox === undefined ? [`${tool} ran unconfined: this host offers no sandbox.`] : [];
}

// What a static check's record says of where its tool ran on this host.
export const hostConfinement =
	hostSandbox === undefined
		? ({ confined: false, reason: "this host offers no sandbox" } as const)
		: ({ confined: true } as const);
