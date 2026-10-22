import { readFileSync } from "node:fs";
import { Instrumenter } from "@stryker-mutator/instrumenter";

const { files, options } = JSON.parse(readFileSync(0, "utf8"));
const logger = { debug() {}, info() {}, warn() {}, isDebugEnabled: () => false };
const { mutants } = await new Instrumenter(logger).instrument(files, options);
console.log(JSON.stringify(mutants));
