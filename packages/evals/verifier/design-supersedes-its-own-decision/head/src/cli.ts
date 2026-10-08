import { canPublish, type Policy } from "./publish.ts";

export function publishCommand(policy: Policy, author: string): string {
	return canPublish(policy, author, { writersTrusted: policy.trustWriters }) ? "published" : "refused";
}

export function republishCommand(policy: Policy, author: string): string {
	return canPublish(policy, author) ? "republished" : "refused";
}
