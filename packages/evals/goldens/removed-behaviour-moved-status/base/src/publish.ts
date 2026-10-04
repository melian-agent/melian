export interface Client {
	setStatus(head: string, state: "success" | "failure", description: string): Promise<void>;
	postReview(head: string, body: string): Promise<void>;
}

/** Publishes a review of `head`. The status goes first, so the head carries one even when the review is refused. */
export async function publish(client: Client, head: string, blocking: boolean, body: string): Promise<void> {
	await client.setStatus(head, blocking ? "failure" : "success", blocking ? "Findings block the merge" : "Nothing blocks");
	await client.postReview(head, body);
}
