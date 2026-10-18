import { builtinProviders, normalizeContext } from "@melian-agent/pipeline/testing";
import { ReasoningCapture } from "../../src/reasoning.ts";

const providers = builtinProviders();
const candidates = providers.flatMap((provider) => provider.getModels().filter((model) => model.reasoning));
const apis = [...new Set(candidates.map((model) => model.api))].sort();
const selected = process.argv[2] === "bedrock" ? ["bedrock-converse-stream"] : apis;
const probes = [];
for (const api of selected) {
	const preferred = api === "bedrock-converse-stream" ? "anthropic.claude-sonnet-5-5" : "gemini-2.5-flash";
	const model =
		candidates.find((item) => item.api === api && item.id === preferred) ??
		candidates.find((item) => item.api === api)!;
	const provider = providers.find((item) => item.id === model.provider)!;
	const capture = new ReasoningCapture(model, "high");
	const payloads: unknown[] = [];
	let fetches = 0;
	const abort = new AbortController();
	globalThis.fetch = async () => {
		fetches++;
		abort.abort();
		throw new Error("offline fetch");
	};
	const token = `offline.${Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "offline" },
		}),
	).toString("base64url")}.offline`;
	const reply = await provider
		.streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "Probe", timestamp: 1 }] }), {
			apiKey: token,
			env: { AZURE_OPENAI_BASE_URL: "https://offline.invalid/openai/v1" },
			reasoning: "high",
			transport: "sse",
			maxRetries: 0,
			signal: abort.signal,
			// Google rejects an injected fetch unless it is also the global fetch.
			fetch: globalThis.fetch,
			onPayload: async (body, sentModel) => {
				payloads.push(JSON.parse(JSON.stringify(body)));
				await capture.options().onPayload!(body, sentModel);
				// Bedrock's AWS SDK ignores fetch; its real payload is captured before client.send.
				if (api === "bedrock-converse-stream") throw new Error("offline Bedrock payload captured");
			},
		})
		.result();
	probes.push({ model, payloads, fetches, error: reply.errorMessage, reasoning: capture.finish(reply) });
}
process.stdout.write(JSON.stringify({ apis, probes }));
