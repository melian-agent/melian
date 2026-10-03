#!/usr/bin/env node
// Committed, executable, and present before any build, so npm links `melian` at install time; the command itself is
// compiled to dist/ by `npm run build`.
import "../dist/bin.js";
