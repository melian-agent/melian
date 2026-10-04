import type { Lock } from "./lock.ts";

/** Runs `job` while holding `lock`, and releases it however `job` ends. */
export async function exclusive<T>(lock: Lock, job: () => Promise<T>): Promise<T> {
	await lock.acquire();
	try {
		return await job();
	} finally {
		lock.release();
	}
}
