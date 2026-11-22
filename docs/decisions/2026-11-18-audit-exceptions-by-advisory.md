# The gate's audit takes exceptions by advisory

Status: the maintainer ruled on 2026-11-18, in the coordinator session, that the gate replace its bare `npm audit` with a script that blocks every advisory at high or above except those a committed file names, each with a reason, as the release-age check works.

## Problem

`npm run check` ran `npm audit --audit-level=high`, which blocks every advisory at high or above. Some advisories cover every released version of a package, so no pull request can fix them.

Example: on 2026-11-17 GitHub published GHSA-fc5q-39xc-vjpf, a high-severity ReDoS in picomatch, for every version up to 4.0.7, the latest. Only dev tools reach picomatch here: vite, vitest, tinyglobby, fdir and Stryker. `npm audit --omit=dev` finds nothing. Still, the gate failed on `main`, and with it every pull request's CI and every merge-group run.

## Choice

`scripts/check-audit.mjs` replaces the bare audit in the `check` script. It runs `npm audit --include=dev --json` and reads each advisory's severity from npm's report, never deriving one itself. It blocks every advisory at high or above, and every advisory whose severity it does not know, unless `.audit-exceptions.json` names it.

- An exception names one advisory by its GHSA ID, taken from the advisory's URL in npm's report, never by package. Each entry carries `id`, `reason` and `added`. The script refuses a file that is not an array, an entry with no GHSA ID, and an entry with no reason.
- An exception applies only while dev dependencies alone reach the advisory. The script runs `npm audit --omit=dev --json` as well, and every advisory at high or above in that report blocks, whatever the file names. npm decides what is shipped; no entry has to list packages.
- An advisory whose URL is not a GitHub advisory has no ID, so no entry can name it, and it blocks.
- The script fails closed. It exits non-zero, saying why, when npm does not start, ends on a signal or an exit code other than 0 or 1, prints no JSON, prints its error report, prints a report other than `auditReportVersion` 2, exits 1 with no vulnerabilities, or lists an advisory with no severity.
- It prints each exception it used. An exception that matches no advisory at high or above is printed as unused, so someone removes it, and does not fail the gate.

The file holds one entry, GHSA-fc5q-39xc-vjpf. An exception is for an advisory with no fixed release; one with a fixed release is fixed by upgrading, as [pull request #160](https://github.com/melian-agent/melian/pull/160) did for Vite.

`scripts/check-audit.test.mjs` tests the decision without the network, against reports npm 11.16.0 wrote on 2026-11-18 under `scripts/fixtures/npm-audit/` and reports built in each test.
