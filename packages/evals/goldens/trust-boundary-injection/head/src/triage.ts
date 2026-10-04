import { addLabel } from "./label.ts";

/** Labels a pull request from the tag its author put in square brackets at the start of its title, if any. */
export function triage(number: number, title: string): void {
	const tag = /^\[([^\]]+)\]/.exec(title)?.[1];
	if (tag !== undefined) addLabel(number, tag);
}
