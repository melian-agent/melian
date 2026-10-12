export const mutationStderrUrl = import.meta.url;

export class MutationStderr {
	#text = "";
	append(text: string): void {
		this.#text = (this.#text + text).slice(-4096);
	}
	read(): string {
		return this.#text.split("\n").slice(-32).join("\n");
	}
}
