export type Policy = { writers: string[]; trustWriters: boolean };

export type PublishOptions = { writersTrusted: boolean };

export function canPublish(policy: Policy, author: string, options: PublishOptions): boolean {
	return options.writersTrusted || policy.writers.includes(author);
}
