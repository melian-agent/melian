export type Identity = { login: string; permission: string };
export type Publication = { head: string; identity: Identity };
export function resume(stored: Publication, head: string, current: Identity): Publication {
	if (stored.head !== head || stored.identity.login !== current.login || stored.identity.permission !== current.permission) {
		return { head, identity: current };
	}
	return { ...stored };
}
