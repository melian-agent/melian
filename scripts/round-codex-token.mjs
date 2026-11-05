// Prints the access token of the Codex login in CODEX_AUTH_B64, for the melian-round workflow to mask and name in a
// secrets file. Exits 1, printing nothing to standard output, when there is no login to read.
// Usage: node scripts/round-codex-token.mjs
import { codexAccessToken } from "./round.mjs";

const token = codexAccessToken(process.env.CODEX_AUTH_B64);
if (token === undefined) {
	process.stderr.write("no Codex access token in CODEX_AUTH_B64\n");
	process.exit(1);
}
process.stdout.write(token);
