// Prints the access token of the Codex login in CODEX_AUTH_B64, for the melian-round workflow to mask and name in a
// secrets file. Exits 1, printing nothing to standard output, when there is no token to read.
// Usage: node scripts/round-codex-token.mjs
import { codexAccessToken } from "./round.mjs";

try {
	process.stdout.write(codexAccessToken(process.env.CODEX_AUTH_B64));
} catch (error) {
	process.stderr.write(`${error.message}\n`);
	process.exit(1);
}
