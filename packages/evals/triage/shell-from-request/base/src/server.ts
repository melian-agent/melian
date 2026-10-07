import { createServer } from "node:http";

export const server = createServer((_request, response) => {
	response.end("ok");
});
