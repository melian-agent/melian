import noSleep from "./tools/no-sleep.js";

export default [
	{
		files: ["src/**/*.js"],
		plugins: { local: { rules: { "no-sleep": noSleep } } },
		rules: { "no-unused-vars": "error", "local/no-sleep": "error" },
	},
];
