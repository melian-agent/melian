import { type ReviewRead, visibleText } from "@melian-agent/core";
import type { Context, Conversation, EntryRecord, ToolCall } from "./harness.ts";

/** Reads the durable history, including reads preceding compaction. */
export class ReviewTranscript {
	readonly #reads: ReviewRead[];
	private constructor(reads: ReviewRead[]) {
		this.#reads = reads;
	}
	/** Fetches every history page before correlating successful results with calls. */
	static async read(
		conversation: Pick<Conversation, "entries">,
		context: Context,
		lens: string,
		paths: readonly string[],
		nonce: string,
	): Promise<ReviewTranscript> {
		const records: EntryRecord[] = [];
		let page = await conversation.entries({}, 200, undefined, context);
		records.push(...page.items);
		while (page.next) {
			page = await conversation.entries({}, 200, page.next, context);
			records.push(...page.items);
		}
		return ReviewTranscript.from(records, lens, paths, nonce);
	}
	/** Counts delivered numbered lines; requests and budget refusals confer no coverage. */
	static from(
		records: readonly EntryRecord[],
		lens: string,
		paths: readonly string[],
		nonce: string,
	): ReviewTranscript {
		const calls = new Map<string, ToolCall>();
		const reads: ReviewRead[] = [];
		const rendered = paths
			.map((path) => ({ path, prefix: `${visibleText(path)}:` }))
			.sort((a, b) => b.prefix.length - a.prefix.length);
		for (const record of records.toSorted((a, b) => a.id - b.id))
			for (const result of record.model ?? []) {
				if (result.role === "assistant") {
					for (const content of result.content) if (content.type === "toolCall") calls.set(content.id, content);
					continue;
				}
				if (result.role !== "toolResult" || result.isError) continue;
				const call = calls.get(result.toolCallId);
				if (!call || !["read_file", "search"].includes(call.name)) continue;
				const label = call.name === "read_file" ? "file" : "search";
				const text = result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				const opening = `<untrusted-${nonce} label="${label}">\n`,
					closing = `\n</untrusted-${nonce}>`;
				if (!text.startsWith(opening)) continue;
				const end = text.indexOf(closing, opening.length);
				if (end < 0) continue;
				const body = text.slice(opening.length, end);
				if (call.name === "read_file") {
					const path = call.arguments.path;
					if (typeof path !== "string" || !paths.includes(path)) continue;
					const lines = body.split("\n").flatMap((line) => {
						const match = /^\s*(\d+)\t/.exec(line);
						return match && Number(match[1]) > 0 ? [Number(match[1])] : [];
					});
					reads.push({
						lens,
						path,
						revision: call.arguments.revision === "base" ? "base" : "head",
						kind: "read",
						lines,
					});
				} else
					for (const line of body.split("\n")) {
						const match = rendered.find((path) => line.startsWith(path.prefix));
						if (!match) continue;
						const number = /^(\d+): /.exec(line.slice(match.prefix.length));
						if (number && Number(number[1]) > 0)
							reads.push({
								lens,
								path: match.path,
								revision: "head",
								kind: "search",
								lines: [Number(number[1])],
							});
					}
			}
		return new ReviewTranscript(reads);
	}
	/** Returns observations for the coverage domain object. */
	reads(): ReviewRead[] {
		return structuredClone(this.#reads);
	}
}
