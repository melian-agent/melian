/** The ports in a comma-separated list, such as "80, 443", as numbers. Throws on anything that is not a port. */
export function parsePorts(list: string): number[] {
	return list.split(",").map((part) => {
		const port = Number(part.trim());
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${part.trim()}`);
		return port;
	});
}
