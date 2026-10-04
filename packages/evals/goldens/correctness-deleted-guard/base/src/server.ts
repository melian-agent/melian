import { createServer, type Server } from "node:http";
import { parsePort } from "./port.ts";

export function start(value: string): Server {
	return createServer().listen(parsePort(value));
}
