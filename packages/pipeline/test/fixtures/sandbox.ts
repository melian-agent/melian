import { Sandbox } from "../../src/sandbox.ts";

/**
 * A stand-in for the host's sandbox that confines nothing. A fake tool that records its calls outside the run's scratch
 * directory needs it, since the real sandbox would not let it write there; the tests of the sandbox itself use the
 * host's.
 */
export const unconfinedSandbox = {
	backend: "seatbelt",
	profile: () => undefined,
	runtimeFailure: () => undefined,
	environment: () => ({}),
	command: (inner: string, paths: { worktree: string }) =>
		`cd '${paths.worktree}' && /bin/bash -c '${inner.replaceAll("'", "'\\''")}'`,
} as unknown as Sandbox;

/** The note a static run of `tool` adds on a host with no sandbox, and nothing where the host has one. */
export function unconfinedNotes(tool: string): string[] {
	return Sandbox.detect() === undefined ? [`${tool} ran unconfined: this host offers no sandbox.`] : [];
}
