// Stryker 10.0.0's Vitest runner picks the tests that cover a mutant by a regular expression of their names joined with
// spaces, and Vitest 5 matches it against names joined with " > ". A test inside a describe never matched, so the mutant
// ran no test and survived. This plugin lets each space in the pattern match either separator. Drop it once a Stryker
// release supports Vitest 5.
export function strykerTestNames() {
	return {
		name: "stryker-test-names",
		configureVitest({ project }) {
			let pattern;
			Object.defineProperty(project.config, "testNamePattern", {
				configurable: true,
				enumerable: true,
				get: () => pattern,
				set(value) {
					pattern =
						value instanceof RegExp ? new RegExp(value.source.replaceAll(" ", "(?: > | )"), value.flags) : value;
				},
			});
		},
	};
}
