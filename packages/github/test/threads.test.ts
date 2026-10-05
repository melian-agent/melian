import { readFileSync } from "node:fs";
import { GitHubError, ReviewThreadImporter } from "@melian-agent/github";
import { type GitHubRecording, recordedGitHub } from "@melian-agent/github/testing";
import { describe, expect, it } from "vitest";

const recording = JSON.parse(
	readFileSync(new URL("./fixtures/review-threads.json", import.meta.url), "utf8"),
) as GitHubRecording;

// Every request the importer sent, so a test can see it paged and never left the recording.
function recorded(answers: GitHubRecording = recording) {
	const requests: { url: string; body: { query: string; variables: Record<string, unknown> } }[] = [];
	const answer = recordedGitHub(answers);
	const fetch: typeof globalThis.fetch = async (input, init) => {
		requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
		return answer(input, init);
	};
	return { fetch, requests };
}

function importer(login?: string, answers?: GitHubRecording) {
	const transport = recorded(answers);
	const opened = ReviewThreadImporter.open({
		owner: "melian-agent",
		repo: "example",
		pullRequest: 7,
		token: "test-token",
		fetch: transport.fetch,
		...(login === undefined ? {} : { login }),
	});
	return { opened, requests: transport.requests };
}

describe("ReviewThreadImporter", () => {
	it("imports CodeRabbit's threads by default, resolved and outdated alike, across pages", async () => {
		const { opened, requests } = importer();

		const imported = await opened.import();

		expect(opened.source).toBe("github:coderabbitai[bot]");
		expect(imported.head).toBe("1".repeat(40));
		expect(imported.findings.map((finding) => finding.toJSON())).toEqual([
			{
				id: expect.stringMatching(/^[0-9a-f]{16}$/),
				reviewer: { name: "coderabbit", login: "coderabbitai[bot]" },
				file: "src/user.ts",
				line: 7,
				endLine: 8,
				title: "_⚠️ Potential issue_ | _🟠 Major_",
				body: expect.stringContaining("**Guard the missing manager.**"),
				source: {
					kind: "thread",
					thread: "PRRT_kwDOAAABc0",
					comment: "2401",
					url: "https://github.com/melian-agent/example/pull/7#discussion_r2401",
				},
				postedAt: "2026-10-05T01:00:00Z",
				resolved: true,
			},
			expect.objectContaining({
				file: "docs/removed.md",
				line: 4,
				endLine: 4,
				outdated: true,
				resolved: false,
				source: expect.objectContaining({ thread: "PRRT_kwDOAAABc2" }),
			}),
		]);
		expect(imported.findings[0]!.site()).toEqual({ file: "src/user.ts", start: 7, end: 8 });
		expect(imported.findings[1]!.site()).toBeUndefined();
		const threads = requests.filter((request) => request.body.query.includes("MelianReviewThreads"));
		expect(threads.map((request) => request.body.variables.after)).toEqual([null, "Y3Vyc29yOjI="]);
		expect(requests.every((request) => request.url === "https://api.github.com/graphql")).toBe(true);
	});

	it("skips and counts the login's review bodies, which have no thread, without parsing them", async () => {
		const { opened } = importer();

		const imported = await opened.import();

		// CodeRabbit posted two reviews, and only one has a body; octocat's review is not CodeRabbit's.
		expect(imported.skippedBodies).toBe(1);
		expect(imported.findings.some((finding) => finding.body.includes("prefer a guard clause"))).toBe(false);
	});

	it("imports another login's threads as a human reviewer's, by that login", async () => {
		const { opened } = importer("octocat");

		const imported = await opened.import();

		expect(opened.source).toBe("github:octocat");
		expect(imported.findings.map((finding) => finding.toJSON())).toEqual([
			expect.objectContaining({
				reviewer: { name: "human", login: "octocat" },
				file: "src/user.ts",
				line: 20,
				endLine: 20,
				title: "Should this log the name too?",
			}),
		]);
		expect(imported.skippedBodies).toBe(1);
	});

	it("gives a thread the same ID on every import, so importing again updates it", async () => {
		const first = await importer().opened.import();
		const second = await importer().opened.import();
		expect(second.findings.map((finding) => finding.id)).toEqual(first.findings.map((finding) => finding.id));
	});

	it("keeps a file-level thread without lines, and marks one on the diff's left side as the base's", async () => {
		const [page] = recording.graphql!.MelianReviewThreads! as {
			data: { repository: { pullRequest: { reviewThreads: { nodes: Record<string, unknown>[] } } } };
		}[];
		const [thread] = page!.data.repository.pullRequest.reviewThreads.nodes;
		const nodes = [
			{ ...thread, id: "PRRT_file", subjectType: "FILE", line: null, startLine: null, originalLine: null },
			{ ...thread, id: "PRRT_left", diffSide: "LEFT" },
		];
		const changed = structuredClone(page!);
		changed.data.repository.pullRequest.reviewThreads = {
			...changed.data.repository.pullRequest.reviewThreads,
			nodes,
			pageInfo: { hasNextPage: false, endCursor: null },
		} as never;
		const answers = { ...recording, graphql: { ...recording.graphql, MelianReviewThreads: [changed] } };

		const imported = await importer(undefined, answers).opened.import();

		const [file, left] = imported.findings.map((finding) => finding.toJSON());
		expect(file).not.toHaveProperty("line");
		expect(file).not.toHaveProperty("outdated");
		expect(left).toMatchObject({ line: 7, endLine: 8, revision: "base" });
		expect(imported.findings.every((finding) => finding.site() === undefined)).toBe(true);
	});

	it("says GitHub has no such pull request, and refuses a login GitHub could not hold", async () => {
		const answers: GitHubRecording = {
			...recording,
			graphql: { MelianReviewThreads: [{ data: { repository: { pullRequest: null } } }] },
		};
		await expect(importer(undefined, answers).opened.import()).rejects.toMatchObject({
			code: "notFound",
			message: expect.stringContaining("no pull request #7 in melian-agent/example"),
		});
		expect(() => importer("not a login")).toThrow(GitHubError);
	});

	it("reports GitHub's refusal without the token", async () => {
		const refusing: typeof fetch = async () =>
			new Response(JSON.stringify({ message: "Bad credentials" }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		const opened = ReviewThreadImporter.open({
			owner: "melian-agent",
			repo: "example",
			pullRequest: 7,
			token: "secret-token-value",
			fetch: refusing,
		});

		const refused = opened.import();

		await expect(refused).rejects.toMatchObject({ code: "unauthorized", status: 401 });
		await expect(refused).rejects.not.toThrow(/secret-token-value/);
	});
});
