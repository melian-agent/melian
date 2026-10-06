import { readFileSync } from "node:fs";
import { GitHubError, ReviewThreadImporter } from "@melian-agent/github";
import { type GitHubRecording, recordedGitHub } from "@melian-agent/github/testing";
import { describe, expect, it } from "vitest";

const recording = JSON.parse(
	readFileSync(new URL("./fixtures/review-threads.json", import.meta.url), "utf8"),
) as GitHubRecording;

type RecordedThread = {
	id: string;
	line: number | null;
	startLine: number | null;
	originalLine: number | null;
	originalStartLine: number | null;
	diffSide: "LEFT" | "RIGHT";
	startDiffSide: "LEFT" | "RIGHT" | null;
	subjectType: "LINE" | "FILE";
	comments: {
		nodes: {
			body: string;
			originalCommit: { oid: string } | null;
			author: { __typename: string; login: string } | null;
		}[];
	};
};

type RecordedThreadsPage = {
	data: {
		repository: {
			pullRequest: {
				headRefOid: string;
				reviewThreads: {
					pageInfo: { hasNextPage: boolean; endCursor: string | null };
					nodes: RecordedThread[];
				};
			};
		};
	};
};

function threadsWith(...patches: Partial<RecordedThread>[]): GitHubRecording {
	const page = structuredClone(recording.graphql!.MelianReviewThreads![0]) as RecordedThreadsPage;
	const [thread] = page.data.repository.pullRequest.reviewThreads.nodes;
	page.data.repository.pullRequest.reviewThreads = {
		pageInfo: { hasNextPage: false, endCursor: null },
		nodes: patches.map((patch, index) => ({ ...thread!, id: `PRRT_test_${index}`, ...patch })),
	};
	return { ...recording, graphql: { ...recording.graphql, MelianReviewThreads: [page] } };
}

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
	it.each(["MelianReviewThreads", "MelianReviews"])(
		"binds repository and pull request arguments to their variables in %s",
		async (operation) => {
			const { opened, requests } = importer();

			await opened.import();

			const pages = requests.filter((request) => request.body.query.includes(operation));
			expect(pages.length).toBeGreaterThan(0);
			for (const request of pages) {
				const query = request.body.query.replace(/\s+/g, " ");
				expect(query).toContain("repository(owner: $owner, name: $name) {");
				expect(query).toContain("pullRequest(number: $number) {");
			}
		},
	);

	it.each([
		["MelianReviewThreads", [null, "Y3Vyc29yOjI="]],
		["MelianReviews", [null]],
	])("sends the repository and pull request on every page of %s", async (operation, cursors) => {
		const { opened, requests } = importer();

		await opened.import();

		expect(
			requests.filter((request) => request.body.query.includes(operation)).map((request) => request.body.variables),
		).toEqual(cursors.map((after) => ({ owner: "melian-agent", name: "example", number: 7, after })));
	});

	it("imports CodeRabbit's threads by default, resolved and outdated alike, across pages", async () => {
		const { opened, requests } = importer();

		const imported = await opened.import();

		expect(opened.source).toBe("github:coderabbitai[bot]");
		expect(imported.head).toBe("1".repeat(40));
		expect(imported.findings.map((finding) => finding.toJSON())).toEqual([
			{
				id: expect.stringMatching(/^[0-9a-f]{16}$/),
				reviewer: { name: "coderabbit", login: "coderabbitai[bot]", kind: "bot" },
				file: "src/user.ts",
				line: 7,
				endLine: 8,
				title: "Guard the missing manager.",
				body: expect.stringContaining("is optional, so `managerName` throws"),
				severity: "_\u26a0\ufe0f Potential issue_ | _\u{1f7e0} Major_",
				source: {
					kind: "thread",
					thread: "PRRT_kwDOAAABc0",
					url: "https://github.com/melian-agent/example/pull/7#discussion_r2401",
				},
				postedAt: "2026-10-05T01:00:00Z",
				commit: "1".repeat(40),
				resolved: true,
			},
			expect.objectContaining({
				title: "The heading names a command that no longer exists.",
				severity: "_\u{1f9f9} Nitpick_ | _\u{1f535} Trivial_",
				file: "docs/removed.md",
				line: 4,
				endLine: 4,
				outdated: true,
				commit: "2".repeat(40),
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

	it("preserves and renders an outdated thread's original multiline span", async () => {
		const answers = threadsWith({
			line: null,
			startLine: null,
			originalStartLine: 7,
			originalLine: 12,
		});

		const [finding] = (await importer(undefined, answers).opened.import()).findings;

		expect(finding?.toJSON()).toMatchObject({ line: 7, endLine: 12, outdated: true });
		expect(finding?.where()).toBe("src/user.ts:7-12 (outdated)");
		expect(finding?.site()).toBeUndefined();
	});

	it.each([
		["current placement", { line: 12, startLine: 9, originalStartLine: 2, originalLine: 5 }, 9, 12, false],
		["single current line", { line: 12, startLine: null, startDiffSide: null }, 12, 12, false],
		["unspecified start side", { line: 12, startLine: 9, startDiffSide: null }, 9, 12, false],
		["start past the end", { line: 12, startLine: 15 }, 12, 12, false],
		[
			"outdated across sides",
			{ line: null, originalLine: 12, originalStartLine: 7, startDiffSide: "LEFT" },
			12,
			12,
			true,
		],
		[
			"missing original lines",
			{ line: null, originalLine: null, originalStartLine: null },
			undefined,
			undefined,
			false,
		],
		[
			"file thread with stale lines",
			{ subjectType: "FILE", line: 12, startLine: 9, originalLine: 5 },
			undefined,
			undefined,
			false,
		],
	] as const)("uses the right lines for %s", async (_name, patch, line, endLine, outdated) => {
		const [finding] = (await importer(undefined, threadsWith(patch)).opened.import()).findings;

		expect(finding?.line).toBe(line);
		expect(finding?.endLine).toBe(endLine);
		expect(finding?.outdated === true).toBe(outdated);
	});

	it("skips threads without a first comment and omits an absent original commit", async () => {
		const page = recording.graphql!.MelianReviewThreads![0] as RecordedThreadsPage;
		const comment = page.data.repository.pullRequest.reviewThreads.nodes[0]!.comments.nodes[0]!;
		const answers = threadsWith(
			{ comments: { nodes: [] } },
			{ comments: { nodes: [{ ...comment, originalCommit: null }] } },
		);

		const imported = await importer(undefined, answers).opened.import();

		expect(imported.findings).toHaveLength(1);
		expect(imported.findings[0]!.toJSON()).not.toHaveProperty("commit");
	});

	it.each([
		["", "(empty comment)", undefined],
		[" \r\n\t", "(empty comment)", undefined],
		["A single-line comment", "A single-line comment", undefined],
		["_Major_\nAn unbolded headline", "An unbolded headline", "_Major_"],
		["_Major_\n</details>\n**Headline after an unmatched close.**", "Headline after an unmatched close.", "_Major_"],
		[
			"_Major_\n</details>\n<details>\n**Hidden evidence.**\n</details>\n**Visible headline.**",
			"Visible headline.",
			"_Major_",
		],
		[`${"\u{1f600}".repeat(101)}\n**Headline.**`, "Headline.", "\u{1f600}".repeat(100)],
	])("reads the title and severity of %j", async (body, title, severity) => {
		const page = recording.graphql!.MelianReviewThreads![0] as RecordedThreadsPage;
		const comment = page.data.repository.pullRequest.reviewThreads.nodes[0]!.comments.nodes[0]!;
		const answers = threadsWith({ comments: { nodes: [{ ...comment, body }] } });

		const [finding] = (await importer(undefined, answers).opened.import()).findings;

		expect(finding?.title).toBe(title);
		expect(finding?.severity).toBe(severity);
		expect(finding?.body).toBe(body);
	});

	it("accepts a bot's suffixed login and keeps a human's multiline comment without bot severity", async () => {
		const page = recording.graphql!.MelianReviewThreads![0] as RecordedThreadsPage;
		const comment = page.data.repository.pullRequest.reviewThreads.nodes[0]!.comments.nodes[0]!;
		const answers = threadsWith(
			{ comments: { nodes: [{ ...comment, author: { __typename: "Bot", login: "CodeRabbitAI[bot]" } }] } },
			{
				comments: {
					nodes: [
						{ ...comment, body: "Human title\nHuman detail", author: { __typename: "User", login: "OctoCat" } },
					],
				},
			},
			{ comments: { nodes: [{ ...comment, author: { __typename: "Bot", login: "constructor" } }] } },
		);

		const rabbit = await importer(undefined, answers).opened.import();
		const human = await importer("octocat", answers).opened.import();
		const other = await importer("constructor", answers).opened.import();

		expect(rabbit.findings).toHaveLength(1);
		expect(rabbit.findings[0]!.reviewer).toEqual({ name: "coderabbit", kind: "bot", login: "CodeRabbitAI[bot]" });
		expect(human.findings).toHaveLength(1);
		expect(human.findings[0]!.title).toBe("Human title");
		expect(human.findings[0]!.severity).toBeUndefined();
		expect(other.findings[0]!.reviewer).toEqual({ name: "human", kind: "bot", login: "constructor[bot]" });
	});

	it.each([
		["collapsed evidence", "<details>\n<summary>Evidence</summary>\n**Evidence heading**\n</details>"],
		["nested evidence", "<details>\n<details>Nested</details>\nEvidence\n</details>"],
		["inline evidence", "<details><summary>Evidence</summary>Evidence</details>"],
	])("reads CodeRabbit's headline after %s", async (_name, evidence) => {
		const pages = structuredClone(recording.graphql!.MelianReviewThreads!) as {
			data: {
				repository: { pullRequest: { reviewThreads: { nodes: { comments: { nodes: { body: string }[] } }[] } } };
			};
		}[];
		const comment = pages[0]!.data.repository.pullRequest.reviewThreads.nodes[0]!.comments.nodes[0]!;
		const category = "_Potential issue_ | _Major_";
		comment.body = `${category}\n\n${evidence}\n\n**Guard the missing manager.**\nThe manager is optional.`;
		const { opened } = importer(undefined, {
			...recording,
			graphql: { ...recording.graphql, MelianReviewThreads: pages },
		});

		const [finding] = (await opened.import()).findings;

		expect(finding?.title).toBe("Guard the missing manager.");
		expect(finding?.severity).toBe(category);
		expect(finding?.body).toBe(comment.body);
	});

	it.each(["<details>\nEvidence\n</details>", "<details>\nEvidence"])(
		"keeps CodeRabbit's second non-blank line when no headline follows %s",
		async (evidence) => {
			const pages = structuredClone(recording.graphql!.MelianReviewThreads!) as {
				data: {
					repository: { pullRequest: { reviewThreads: { nodes: { comments: { nodes: { body: string }[] } }[] } } };
				};
			}[];
			pages[0]!.data.repository.pullRequest.reviewThreads.nodes[0]!.comments.nodes[0]!.body =
				`_Potential issue_ | _Major_\n\n${evidence}`;
			const { opened } = importer(undefined, {
				...recording,
				graphql: { ...recording.graphql, MelianReviewThreads: pages },
			});

			expect((await opened.import()).findings[0]?.title).toBe("<details>");
		},
	);

	it("requests every field it reads and each thread's first comment so replies cannot decide attribution", async () => {
		const { opened, requests } = importer();

		await opened.import();

		const threads = requests.filter((request) => request.body.query.includes("MelianReviewThreads"));
		expect(threads).toHaveLength(2);
		for (const request of threads) {
			const query = request.body.query.replace(/\s+/g, " ");
			expect(query).toContain("headRefOid reviewThreads(first: 100, after: $after) {");
			expect(query).toContain("pageInfo { hasNextPage endCursor }");
			expect(query).toContain(
				"nodes { id isResolved path line startLine originalLine originalStartLine diffSide startDiffSide subjectType comments(first: 1) { nodes { url body createdAt originalCommit { oid } author { __typename login } } } }",
			);
		}
		const reviews = requests.filter((request) => request.body.query.includes("MelianReviews"));
		expect(reviews).toHaveLength(1);
		for (const request of reviews) {
			const query = request.body.query.replace(/\s+/g, " ");
			expect(query).toContain("reviews(first: 100, after: $after) {");
			expect(query).toContain("pageInfo { hasNextPage endCursor }");
			expect(query).toContain("nodes { body author { __typename login } }");
		}
	});

	it("refuses thread pages placed at different pull request heads", async () => {
		const pages = structuredClone(recording.graphql!.MelianReviewThreads!) as {
			data: { repository: { pullRequest: { headRefOid: string } } };
		}[];
		pages[1]!.data.repository.pullRequest.headRefOid = "3".repeat(40);
		const { opened, requests } = importer(undefined, {
			...recording,
			graphql: { ...recording.graphql, MelianReviewThreads: pages },
		});

		const refused = opened.import();

		await expect(refused).rejects.toThrow(GitHubError);
		await expect(refused).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("moved") });
		expect(requests).toHaveLength(2);
	});

	it("skips and counts the login's review bodies, which have no thread, without parsing them", async () => {
		const { opened } = importer();

		const imported = await opened.import();

		// CodeRabbit posted two reviews, and only one has a body; octocat's review is not CodeRabbit's.
		expect(imported.skippedBodies).toBe(1);
		expect(imported.findings.some((finding) => finding.body.includes("prefer a guard clause"))).toBe(false);
	});

	it("counts CodeRabbit's review bodies across pages", async () => {
		const answers: GitHubRecording = {
			...recording,
			graphql: {
				...recording.graphql,
				MelianReviews: [
					{
						data: {
							repository: {
								pullRequest: {
									reviews: {
										pageInfo: { hasNextPage: true, endCursor: "review-1" },
										nodes: [
											{ body: "First review body", author: { __typename: "Bot", login: "coderabbitai" } },
										],
									},
								},
							},
						},
					},
					{
						data: {
							repository: {
								pullRequest: {
									reviews: {
										pageInfo: { hasNextPage: false, endCursor: "review-2" },
										nodes: [
											{ body: "Second review body", author: { __typename: "Bot", login: "coderabbitai" } },
										],
									},
								},
							},
						},
					},
				],
			},
		};
		const { opened, requests } = importer(undefined, answers);

		const imported = await opened.import();

		expect(imported.skippedBodies).toBe(2);
		const reviews = requests.filter((request) => request.body.query.includes("MelianReviews"));
		expect(reviews.map((request) => request.body.variables.after)).toEqual([null, "review-1"]);
	});

	it("imports another login's threads as a human reviewer's, by that login", async () => {
		const { opened } = importer("octocat");

		const imported = await opened.import();

		expect(opened.source).toBe("github:octocat");
		expect(imported.findings.map((finding) => finding.toJSON())).toEqual([
			expect.objectContaining({
				reviewer: { name: "human", login: "octocat", kind: "user" },
				file: "src/user.ts",
				line: 20,
				endLine: 20,
				title: "Should this log the name too?",
			}),
		]);
		expect(imported.skippedBodies).toBe(1);
	});

	it("accepts an Enterprise Managed Users login, which carries an underscore", () => {
		const { opened } = importer("alice_acme");

		expect(opened.source).toBe("github:alice_acme");
	});

	it("knows CodeRabbit by its bare login too, which GraphQL spells without [bot]", async () => {
		const { opened } = importer("CodeRabbitAI");

		const imported = await opened.import();

		expect(imported.findings).toHaveLength(2);
		expect(imported.findings[0]!.reviewer).toEqual({ name: "coderabbit", login: "coderabbitai[bot]", kind: "bot" });
		expect(imported.skippedBodies).toBe(1);
	});

	it("names Copilot's bot, keeps any other bot as a human by its login, and never takes a person for a bot", async () => {
		const [page] = recording.graphql!.MelianReviewThreads! as {
			data: { repository: { pullRequest: { reviewThreads: { nodes: { comments: { nodes: object[] } }[] } } } };
		}[];
		const [thread] = page!.data.repository.pullRequest.reviewThreads.nodes;
		const by = (id: string, author: object) => ({
			...thread,
			id,
			comments: { nodes: [{ ...thread!.comments.nodes[0], author }] },
		});
		const changed = structuredClone(page!);
		changed.data.repository.pullRequest.reviewThreads = {
			pageInfo: { hasNextPage: false, endCursor: null },
			nodes: [
				by("PRRT_copilot", { __typename: "Bot", login: "copilot-pull-request-reviewer" }),
				by("PRRT_other", { __typename: "Bot", login: "renovate" }),
				by("PRRT_person", { __typename: "User", login: "coderabbitai" }),
			],
		} as never;
		const answers = { ...recording, graphql: { ...recording.graphql, MelianReviewThreads: [changed] } };

		const copilot = await importer("copilot-pull-request-reviewer[bot]", answers).opened.import();
		const other = await importer("renovate[bot]", answers).opened.import();
		const rabbit = await importer(undefined, answers).opened.import();

		expect(copilot.findings.map((each) => each.reviewer)).toEqual([
			{ name: "copilot", login: "copilot-pull-request-reviewer[bot]", kind: "bot" },
		]);
		expect(other.findings.map((each) => each.reviewer)).toEqual([
			{ name: "human", login: "renovate[bot]", kind: "bot" },
		]);
		// A person whose login is the bot's bare name is not the bot.
		expect(rabbit.findings).toEqual([]);
	});

	it("retains reviewer identity when an import contains no threads", async () => {
		const human = await importer("absent-reviewer").opened.import();
		expect(human.findings).toEqual([]);
		expect(human.reviewers).toEqual([{ name: "human", login: "absent-reviewer", kind: "user" }]);
		const changed = structuredClone(recording);
		const pages = changed.graphql!.MelianReviewThreads! as {
			data: { repository: { pullRequest: { reviewThreads: { nodes: unknown[] } } } };
		}[];
		for (const page of pages) page.data.repository.pullRequest.reviewThreads.nodes = [];
		const reviewPages = changed.graphql!.MelianReviews! as {
			data: { repository: { pullRequest: { reviews: { nodes: unknown[] } } } };
		}[];
		for (const page of reviewPages) page.data.repository.pullRequest.reviews.nodes = [];
		const bot = await importer(undefined, changed).opened.import();
		expect(bot.findings).toEqual([]);
		expect(bot.reviewers).toEqual([{ name: "coderabbit", login: "coderabbitai[bot]", kind: "bot" }]);
	});

	it("gives a thread the same ID on every import, so importing again updates it", async () => {
		const first = await importer().opened.import();
		const second = await importer().opened.import();
		expect(second.findings.map((finding) => finding.id)).toEqual(first.findings.map((finding) => finding.id));
	});

	it("keeps a file-level thread without lines, marks the left side's as the base's, and skips a deleted author's", async () => {
		const [page] = recording.graphql!.MelianReviewThreads! as {
			data: {
				repository: {
					pullRequest: {
						reviewThreads: { nodes: (Record<string, unknown> & { comments: { nodes: object[] } })[] };
					};
				};
			};
		}[];
		const [thread] = page!.data.repository.pullRequest.reviewThreads.nodes;
		const nodes = [
			{ ...thread, id: "PRRT_file", subjectType: "FILE", line: null, startLine: null, originalLine: null },
			{ ...thread, id: "PRRT_left", diffSide: "LEFT", startDiffSide: "LEFT" },
			// A span that starts on the base side and ends at head names lines of two files, so only its end is kept.
			{ ...thread, id: "PRRT_across", startDiffSide: "LEFT" },
			{ ...thread, id: "PRRT_ghost", comments: { nodes: [{ ...thread!.comments.nodes[0], author: null }] } },
		];
		const changed = structuredClone(page!);
		changed.data.repository.pullRequest.reviewThreads = {
			...changed.data.repository.pullRequest.reviewThreads,
			nodes,
			pageInfo: { hasNextPage: false, endCursor: null },
		} as never;
		const answers = { ...recording, graphql: { ...recording.graphql, MelianReviewThreads: [changed] } };

		const imported = await importer(undefined, answers).opened.import();

		const [file, left, across] = imported.findings.map((finding) => finding.toJSON());
		expect(imported.findings).toHaveLength(3);
		expect(file).not.toHaveProperty("line");
		expect(file).not.toHaveProperty("outdated");
		expect(left).toMatchObject({ line: 7, endLine: 8, revision: "base" });
		expect(across).toMatchObject({ line: 8, endLine: 8 });
		expect(across).not.toHaveProperty("revision");
		expect(imported.findings.map((finding) => finding.site())).toEqual([
			undefined,
			undefined,
			{ file: "src/user.ts", start: 8, end: 8 },
		]);
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

	it.each([
		[401, "unauthorized"],
		[403, "forbidden"],
		[404, "notFound"],
		[500, "failed"],
	])("maps HTTP %i to a typed GitHub error", async (status, code) => {
		const opened = ReviewThreadImporter.open({
			owner: "melian-agent",
			repo: "example",
			pullRequest: 7,
			token: "test-token",
			fetch: async () =>
				new Response(JSON.stringify({ message: "Refused" }), {
					status,
					headers: { "content-type": "application/json" },
				}),
		});

		await expect(opened.import()).rejects.toMatchObject({
			code,
			status,
		});
	});

	it("reports GraphQL errors without inventing an HTTP status", async () => {
		const opened = ReviewThreadImporter.open({
			owner: "melian-agent",
			repo: "example",
			pullRequest: 7,
			token: "test-token",
			fetch: async () =>
				new Response(JSON.stringify({ errors: [{ message: "Query refused" }] }), {
					headers: { "content-type": "application/json" },
				}),
		});
		const refused = opened.import();

		await expect(refused).rejects.toMatchObject({
			code: "failed",
			message: expect.stringContaining("Query refused"),
		});
		await expect(refused).rejects.toHaveProperty("status", undefined);
	});

	it.each([
		[null, "null", undefined],
		["response failed", "response failed", undefined],
		[{ status: "503" }, "[object Object]", undefined],
		[{ status: 503 }, "[object Object]", 503],
		[new Error("response failed"), "response failed", undefined],
	])("wraps an unexpected response-reading failure %j", async (failure, message, status) => {
		const opened = ReviewThreadImporter.open({
			owner: "melian-agent",
			repo: "example",
			pullRequest: 7,
			token: "test-token",
			fetch: async () => {
				const response = new Response();
				Object.defineProperty(response, "status", {
					get: () => {
						// Octokit's request logger reads error.response before the importer catches the rejection.
						throw Object.defineProperty(new Error("unreadable response"), "response", {
							get: () => {
								throw failure;
							},
						});
					},
				});
				return response;
			},
		});
		const refused = opened.import();

		await expect(refused).rejects.toBeInstanceOf(GitHubError);
		await expect(refused).rejects.toMatchObject({
			code: "failed",
			message: `GitHub refused to read the review threads of pull request #7: ${status === undefined ? "" : `${status} `}${message}`,
			status,
		});
	});

	it.each([null, {}, { pullRequest: null }, { pullRequest: undefined }])(
		"refuses a missing repository or pull request %j in either query",
		async (repository) => {
			for (const operation of ["MelianReviewThreads", "MelianReviews"]) {
				const answers = {
					...recording,
					graphql: { ...recording.graphql, [operation]: [{ data: { repository } }] },
				};
				await expect(importer(undefined, answers).opened.import()).rejects.toMatchObject({ code: "notFound" });
			}
		},
	);

	it("uses an enterprise GraphQL endpoint", async () => {
		const requests: string[] = [];
		const answer = recordedGitHub(recording);
		const opened = ReviewThreadImporter.open({
			owner: "melian-agent",
			repo: "example",
			pullRequest: 7,
			token: "test-token",
			apiUrl: "https://github.example/api/v3",
			fetch: async (input, init) => {
				requests.push(String(input));
				const url = new URL(String(input));
				url.pathname = "/graphql";
				return answer(url, init);
			},
		});

		await opened.import();

		expect(requests).toEqual(Array.from({ length: 3 }, () => "https://github.example/api/graphql"));
	});

	it("opens with the default transport without making a request", () => {
		expect(
			ReviewThreadImporter.open({ owner: "melian-agent", repo: "example", pullRequest: 7, token: "test-token" })
				.source,
		).toBe("github:coderabbitai[bot]");
	});

	it.each(["MelianReviewThreads", "MelianReviews"])("stops %s when a next page has no cursor", async (operation) => {
		const pages = structuredClone(recording.graphql![operation]!) as {
			data: {
				repository: {
					pullRequest: Record<string, { pageInfo: { hasNextPage: boolean; endCursor: string | null } }>;
				};
			};
		}[];
		const connection = operation === "MelianReviewThreads" ? "reviewThreads" : "reviews";
		pages[0]!.data.repository.pullRequest[connection]!.pageInfo = { hasNextPage: true, endCursor: null };
		const { opened, requests } = importer(undefined, {
			...recording,
			graphql: { ...recording.graphql, [operation]: pages },
		});

		await opened.import();

		expect(requests.filter((request) => request.body.query.includes(operation))).toHaveLength(1);
	});

	it.each(["MelianReviewThreads", "MelianReviews"])("accepts the last allowed page of %s", async (operation) => {
		const connection = operation === "MelianReviewThreads" ? "reviewThreads" : "reviews";
		const pages = Array.from({ length: 50 }, (_, index) => ({
			data: {
				repository: {
					pullRequest: {
						headRefOid: "1".repeat(40),
						[connection]: { pageInfo: { hasNextPage: index < 49, endCursor: `last-${index}` }, nodes: [] },
					},
				},
			},
		}));
		const { opened, requests } = importer(undefined, {
			...recording,
			graphql: { ...recording.graphql, [operation]: pages },
		});

		const imported = await opened.import();

		expect(imported.head).toBe("1".repeat(40));
		expect(requests.filter((request) => request.body.query.includes(operation))).toHaveLength(50);
	});

	it.each(["MelianReviewThreads", "MelianReviews"])("fails past the page cap for %s", async (operation) => {
		const connection = operation === "MelianReviewThreads" ? "reviewThreads" : "reviews";
		const page = (cursor: number) => ({
			data: {
				repository: {
					pullRequest: {
						headRefOid: "1".repeat(40),
						[connection]: { pageInfo: { hasNextPage: true, endCursor: `cursor-${cursor}` }, nodes: [] },
					},
				},
			},
		});
		const answers: GitHubRecording = {
			...recording,
			graphql: { ...recording.graphql, [operation]: Array.from({ length: 51 }, (_, index) => page(index)) },
		};
		const { opened, requests } = importer(undefined, answers);

		await expect(opened.import()).rejects.toMatchObject({
			code: "failed",
			message: expect.stringContaining("has more than 5000 threads or reviews"),
		});
		expect(requests.filter((request) => request.body.query.includes(operation))).toHaveLength(50);
	});
});
