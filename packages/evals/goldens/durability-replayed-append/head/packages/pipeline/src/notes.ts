import { type Context, type ConversationId, type DocumentReader, defineDoc, defineTool, Type } from "./harness.ts";

/** One note the summariser attaches to a line of the change, shown in the walkthrough. */
export type Note = { file: string; line: number; text: string };

// A type alias, not an interface: a document's value must satisfy Pi's JsonObject.
type NotesState = { revisions: Record<string, Note[]> };

// Owned by the changeset's root conversation, so a fork of the root at a revision carries that revision's notes.
export const NotesDocument = defineDoc<NotesState>({
	kind: "melian.notes",
	version: 1,
	scope: "conversation",
	initial: () => ({ revisions: {} }),
});

/** The notes recorded for `revision`, in the order the summariser wrote them. */
export async function readNotes(
	reader: DocumentReader,
	root: ConversationId,
	revision: string,
	context: Context,
): Promise<Note[]> {
	const state = await reader.snapshot(NotesDocument, root, context);
	return (state?.revisions[revision] ?? []).map((note) => ({ ...note }));
}

/**
 * The summariser's `add_note` tool. It records each note for `revision` in the root conversation's notes, whichever
 * conversation calls it, so the walkthrough lists them in the order they were written.
 */
export function addNoteTool(root: ConversationId, revision: string) {
	return defineTool({
		name: "add_note",
		description: "Attach one note to a line of the change. The walkthrough lists notes in the order you add them.",
		parameters: Type.Object({
			file: Type.String({ minLength: 1, description: "Repository-relative path at the head revision" }),
			line: Type.Integer({ minimum: 1 }),
			text: Type.String({ minLength: 1, maxLength: 500 }),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			await api.commit(async (tx) => {
				const document = await tx.doc(NotesDocument, root);
				const notes = document.revisions[revision] ?? [];
				document.revisions[revision] = [...notes, { file: args.file, line: args.line, text: args.text }];
				return undefined;
			}, context);
			return { content: [{ type: "text", text: `noted ${args.file}:${args.line}` }] };
		},
	});
}
