/** Posts a review comment on a pull request with the token the workflow provides. */
export async function comment(repository: string, pullRequest: number, body: string): Promise<void> {
	const response = await fetch(`https://api.github.com/repos/${repository}/issues/${pullRequest}/comments`, {
		method: "POST",
		headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
		body: JSON.stringify({ body }),
	});
	if (!response.ok) throw new Error(`GitHub refused the comment: ${response.status}`);
}
