import { Instrumenter } from "@stryker-mutator/instrumenter";

// A synchronous read of a pipe fails with EAGAIN once the input outgrows the pipe's buffer, so read the stream.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { files, options } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const logger = { debug() {}, info() {}, warn() {}, isDebugEnabled: () => false };
const { mutants } = await new Instrumenter(logger).instrument(files, options);
console.log(JSON.stringify(mutants));
