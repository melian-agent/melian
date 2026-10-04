import { type Context, type ConversationId, type DocumentReader, defineDoc, defineTool, Type } from "./harness.ts";

/** One note the summariser attaches to a line of the change, shown in the walkthrough. */
export type Note = { file: string; line: number; text: string };

// A type alias, not an interface: a document's value must satisfy Pi's JsonObject. Each revision's notes are keyed by
// `noteKey`, so a line holds at most one note.
type NotesState = { revisions: Record<string, Record<string, Note>> };

// Owned by the changeset's root conversation, so a fork of the root at a revision carries that revision's notes.
export const NotesDocument = defineDoc<NotesState>({
	kind: "melian.notes",
	version: 1,
	scope: "conversation",
	initial: () => ({ revisions: {} }),
});

/** The key of the note on `line` of `file`. */
export function noteKey(file: string, line: number): string {
	return JSON.stringify([file, line]);
}

/** The notes recorded for `revision`, by file and then line. */
export async function readNotes(
	reader: DocumentReader,
	root: ConversationId,
	revision: string,
	context: Context,
): Promise<Note[]> {
	const state = await reader.snapshot(NotesDocument, root, context);
	return Object.values(state?.revisions[revision] ?? {})
		.map((note) => ({ ...note }))
		.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/**
 * The summariser's `add_note` tool. It records the note for one line of `revision` in the root conversation's notes,
 * whichever conversation calls it. A line holds one note, so a second call for it replaces the first.
 */
export function addNoteTool(root: ConversationId, revision: string) {
	return defineTool({
		name: "add_note",
		description: "Attach a note to a line of the change. A line holds one note; calling again for it replaces the note.",
		parameters: Type.Object({
			file: Type.String({ minLength: 1, description: "Repository-relative path at the head revision" }),
			line: Type.Integer({ minimum: 1 }),
			text: Type.String({ minLength: 1, maxLength: 500 }),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const note: Note = { file: args.file, line: args.line, text: args.text };
			await api.commit(async (tx) => {
				const document = await tx.doc(NotesDocument, root);
				document.revisions[revision] = { ...document.revisions[revision], [noteKey(note.file, note.line)]: note };
				return undefined;
			}, context);
			return { content: [{ type: "text", text: `noted ${args.file}:${args.line}` }] };
		},
	});
}
