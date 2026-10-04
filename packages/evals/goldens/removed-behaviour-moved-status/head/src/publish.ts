export interface Client {
	setStatus(head: string, state: "success" | "failure", description: string): Promise<void>;
	postReview(head: string, body: string): Promise<void>;
}

/** Publishes a review of `head`: the review, then the status that summarises it. */
export async function publish(client: Client, head: string, blocking: boolean, body: string): Promise<void> {
	await client.postReview(head, body);
	await finish(client, head, blocking);
}

async function finish(client: Client, head: string, blocking: boolean): Promise<void> {
	await client.setStatus(head, blocking ? "failure" : "success", blocking ? "Findings block the merge" : "Nothing blocks");
}
