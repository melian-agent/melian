export async function retry<T>(attempts: number, run: () => Promise<T>): Promise<T> {
	let last: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			return await run();
		} catch (error) {
			last = error;
		}
	}
	throw last;
}
