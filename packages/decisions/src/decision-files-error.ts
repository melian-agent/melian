/** A decision file could not supply a complete, unambiguous baseline. */
export class DecisionFilesError extends Error {
	readonly code: "incomplete" | "invalid";

	constructor(code: "incomplete" | "invalid", message: string) {
		super(message);
		this.name = "DecisionFilesError";
		this.code = code;
	}
}
