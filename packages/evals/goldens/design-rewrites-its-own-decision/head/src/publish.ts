export type Policy = { writers: string[]; trustWriters: boolean };

export type PublishOptions = { writersTrusted?: boolean };

export function canPublish(policy: Policy, author: string, options: PublishOptions = {}): boolean {
	const trusted = options.writersTrusted ?? true;
	return trusted || policy.writers.includes(author);
}
