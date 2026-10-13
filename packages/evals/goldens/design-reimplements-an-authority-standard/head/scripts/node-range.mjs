// Re-derives by hand what semver's `satisfies` answers for the `engines.node` range in package.json.
// semver cannot be asked here: npm runs check-node.mjs as `preinstall`, before it installs any dependency,
// so `node_modules` does not exist yet. This reads only a `>=<major>` range and a released `v<major>.<minor>.<patch>`,
// with no leading zero and a major under 10000, and answers false for anything else, which refuses the install.
export function supported(range, version) {
	const wanted = /^>=([1-9]\d*)$/.exec(range);
	const running = /^v([1-9]\d{0,3})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/.exec(version);
	return wanted !== null && running !== null && Number(running[1]) >= Number(wanted[1]);
}
