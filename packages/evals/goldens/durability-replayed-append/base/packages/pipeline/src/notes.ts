import { type Context, type ConversationId, type DocumentReader, defineDoc } from "./harness.ts";

/** One note the summariser attaches to a line of the change, shown in the walkthrough. */
export type Note = { file: string; line: number; text: string };

// A type alias, not an interface: a document's value must satisfy Pi's JsonObject.
type NotesState = { revisions: Record<string, Note[]> };

// Owned by the changeset's root conversation, so a fork of the root at a revision carries that revision's notes.
export const NotesDocument = defineDoc<NotesState>({
	kind: "melian.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
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
