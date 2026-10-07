import type { Sandbox } from "../../src/sandbox.ts";

/**
 * A stand-in for the host's sandbox that confines nothing. A fake Stryker records its calls outside the run's scratch
 * directory, which the real sandbox would not let it write; the tests of the sandbox itself use the host's.
 */
export const unconfinedSandbox = {
	backend: "seatbelt",
	profile: () => undefined,
	command: (inner: string, paths: { worktree: string }) =>
		`cd '${paths.worktree}' && /bin/bash -c '${inner.replaceAll("'", "'\\''")}'`,
} as unknown as Sandbox;
