/** Posts `body` as a new comment on pull request `number`. Every call posts another comment. */
export async function postComment(number: number, body: string): Promise<void> {
	const response = await fetch(`https://api.github.com/repos/melian-agent/melian/issues/${number}/comments`, {
		method: "POST",
		body: JSON.stringify({ body }),
	});
	if (!response.ok) throw new Error(`posting a comment on #${number} failed: ${response.status}`);
}
