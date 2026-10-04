/** Reports a call to `sleep`, which a debugging session left behind and which slows every request. */
export default {
	meta: {
		type: "problem",
		messages: { sleep: "Remove this call to sleep." },
		schema: [],
	},
	create(context) {
		return {
			CallExpression(node) {
				if (node.callee.type === "Identifier" && node.callee.name === "sleep") {
					context.report({ node, messageId: "sleep" });
				}
			},
		};
	},
};
