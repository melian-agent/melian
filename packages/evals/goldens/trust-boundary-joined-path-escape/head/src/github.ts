export async function postComment(body: string): Promise<void> {
	const url = `${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}/issues/${process.env.PR_NUMBER}/comments`;
	const response = await fetch(url, {
		method: "POST",
		headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify({ body }),
	});
	if (!response.ok) throw new Error(`posting the summary failed with ${response.status}`);
}
