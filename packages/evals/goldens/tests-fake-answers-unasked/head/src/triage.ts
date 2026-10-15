export type Priority = "P1" | "P2" | "P3";
export type Ticket = { title: string; body: string; priority: Priority };
export type Request = { instructions: string; input: Record<string, string> };
export type Model = { ask(request: Request): Promise<string> };

const priorities: readonly Priority[] = ["P1", "P2", "P3"];

export async function classify(ticket: Ticket, model: Model): Promise<Priority> {
	const answer = await model.ask({
		instructions: "Answer with the priority this ticket deserves: P1, P2, or P3.",
		input: { title: ticket.title, body: ticket.body },
	});
	return parsePriority(answer);
}

export async function downgrade(ticket: Ticket, model: Model): Promise<Priority> {
	const answer = await model.ask({
		instructions:
			"If the ticket is less urgent than its priority says, answer with the priority one step lower. Otherwise answer with its priority.",
		input: { title: ticket.title, body: ticket.body },
	});
	return parsePriority(answer);
}

function parsePriority(answer: string): Priority {
	const priority = priorities.find((each) => each === answer.trim());
	if (priority === undefined) throw new Error(`the model answered ${answer}, not a priority`);
	return priority;
}
