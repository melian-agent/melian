/** Every line inside a fenced bash block of `markdown`, trimmed: the commands a skill tells an agent to run. */
export function commandsIn(markdown: string): string[] {
	const commands: string[] = [];
	let fenced = false;
	for (const line of markdown.split("\n")) {
		if (line.startsWith("```")) fenced = !fenced && line.trim() === "```bash";
		else if (fenced && line.trim() !== "") commands.push(line.trim());
	}
	return commands;
}
