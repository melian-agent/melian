// Node 22 warns on every run that node:sqlite is experimental, which reads to a user as something wrong with their
// review. Melian's storage is Pi Durable's SQLite backend, pinned and tested on every Node version CI runs, so the
// command drops that one warning and prints every other as Node would. Imported before anything loads node:sqlite.
const printers = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
	if (warning.name === "ExperimentalWarning" && warning.message.startsWith("SQLite is an experimental feature"))
		return;
	for (const print of printers) print(warning);
});
