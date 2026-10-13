// Re-derives by hand what semver's `satisfies` answers for the `engines.node` range in package.json.
// semver cannot be asked here: npm runs check-node.mjs as `preinstall`, before it installs any dependency,
// so `node_modules` does not exist yet. This reads only a `>=<major>` range and a released `v<major>.<minor>.<patch>`,
// and answers false for anything else, a prerelease included, so an unreadable range or version refuses the install.
export function supported(range, version) {
	const wanted = /^>=(\d+)$/.exec(range);
	const running = /^v(\d+)\.\d+\.\d+$/.exec(version);
	return wanted !== null && running !== null && Number(running[1]) >= Number(wanted[1]);
}
