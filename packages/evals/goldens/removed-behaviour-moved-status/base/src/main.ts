import { type Client, publish } from "./publish.ts";

/** Publishes a stored review, and says so when the provider refuses it, so the user can run it again. */
export async function publishStored(client: Client, head: string, blocking: boolean, body: string): Promise<number> {
	try {
		await publish(client, head, blocking, body);
		return 0;
	} catch (error) {
		console.error(`publish failed: ${error instanceof Error ? error.message : String(error)}; run it again`);
		return 1;
	}
}
