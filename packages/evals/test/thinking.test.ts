import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "@melian-agent/core";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptVerifier,
	systemPromptOf,
} from "@melian-agent/pipeline/testing";
import { expect, it, vi } from "vitest";
import { loadGoldens, runGolden } from "../src/goldens.ts";
import { reportTriageGoldens } from "../src/live-output.ts";
import { EvalThinking } from "../src/thinking.ts";
import { loadTriageGoldens, runTriageGolden } from "../src/triage.ts";
import { loadVerifierGoldens, runVerifierGolden } from "../src/verifier.ts";

it("applies a per-run level over routes without losing their models or fallbacks", () => {
	const config = {
		...defaultConfig,
		models: { heavy: { model: "faux/finder", fallbacks: ["faux/fallback"], thinking: "low" as const } },
	};
	const override = EvalThinking.parse("heavy=medium, verifier=high,light=off");
	expect(override.apply(config).models).toEqual({
		heavy: { model: "faux/finder", fallbacks: ["faux/fallback"], thinking: "medium" },
		verifier: { thinking: "high" },
		light: { thinking: "off" },
	});
	expect(config.models.heavy.thinking).toBe("low");
	expect(override.level("heavy")).toBe("medium");
	expect(override.level("decision")).toBeUndefined();
});

it.each([undefined, ""])("leaves routes unchanged for %s", (value) => {
	expect(EvalThinking.parse(value).apply(defaultConfig)).toEqual(defaultConfig);
});

it.each(["bad=high", "heavy=none", "heavy", "heavy=high=low", "heavy=low,heavy=high", ",", "heavy="])(
	"refuses an invalid override %s",
	(value) => {
		expect(() => EvalThinking.parse(value)).toThrow("MELIAN_EVAL_THINKING");
	},
);

it("rejects an invalid environment override before opening live credentials", () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-thinking-env-")));
	try {
		const result = spawnSync(
			process.execPath,
			["--conditions=@melian-agent/source", fileURLToPath(new URL("../src/live.ts", import.meta.url))],
			{
				cwd: directory,
				encoding: "utf8",
				env: {
					PATH: process.env.PATH,
					XDG_CONFIG_HOME: directory,
					PI_CODING_AGENT_DIR: directory,
					MELIAN_EVAL_LIVE: "1",
					MELIAN_EVAL_THINKING: "heavy=invalid",
				},
			},
		);
		expect(result.status).toBe(2);
		expect(result.stderr.trim()).toBe(
			'MELIAN_EVAL_THINKING needs distinct tier=level entries; invalid entry "heavy=invalid"',
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it("applies live lens, verifier and triage overrides to fake provider bodies and spend", async () => {
	const fake = createFakeModels();
	const received: unknown[] = [];
	fake.provider.setResponses(
		Array.from({ length: 20 }, () => async (request, options, _state, model) => {
			const body = { reasoning: { effort: options?.reasoning } };
			received.push(body);
			await options?.onPayload?.(body, model);
			if (systemPromptOf(request.messages).includes("Melian adversarial verifier"))
				return scriptVerifier(request.messages);
			if (systemPromptOf(request.messages).includes("You answer typed questions")) {
				const prompt = request.messages
					.filter((message) => message.role === "user")
					.map((message) => message.content)
					.join("\n");
				const questions = [...prompt.matchAll(/^### (.+)$/gm)].map((match) => match[1]!);
				return fauxAssistantMessage(
					fauxToolCall("answer", {
						answers: questions.map((question) => ({
							question,
							probabilities: [{ option: "careful", probability: 1 }],
						})),
					}),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("Done.");
		}),
	);
	const mode = {
		kind: "live" as const,
		models: fake.review,
		model: "faux/faux-1",
		thinking: EvalThinking.parse("heavy=medium,light=minimal,verifier=high"),
	};
	const lens = await runGolden(loadGoldens().find((golden) => golden.name === "correctness-deleted-guard")!, mode);
	expect(received.length).toBeGreaterThan(0);
	expect(received).toEqual(received.map(() => ({ reasoning: { effort: "medium" } })));
	expect(lens.telemetry.spend()).toContain("requested=medium");
	received.length = 0;
	const verifier = await runVerifierGolden(loadVerifierGoldens()[0]!, mode);
	expect(received.length).toBeGreaterThan(0);
	expect(received).toEqual(received.map(() => ({ reasoning: { effort: "high" } })));
	expect(verifier.telemetry.spend()).toContain("requested=high");
	expect(verifier.verification?.verdict).toBe("confirmed");
	received.length = 0;
	const triage = createFakeModels();
	const direct = vi.spyOn(triage.models, "completeSimple").mockImplementation(async (_model, request, options) => {
		received.push({ reasoning: { effort: options?.reasoning } });
		const prompt = request.messages
			.filter((message) => message.role === "user")
			.map((message) => message.content)
			.join("\n");
		const questions = [...prompt.matchAll(/^### (.+)$/gm)].map((match) => match[1]!);
		return fauxAssistantMessage(
			fauxToolCall("answer", {
				answers: questions.map((question) => ({
					question,
					probabilities: [{ option: "careful", probability: 1 }],
				})),
			}),
			{ stopReason: "toolUse" },
		);
	});
	try {
		await runTriageGolden(loadTriageGoldens()[0]!, { ...mode, models: triage.review, model: "faux/faux-1" });
		const printed: string[] = [];
		const measurement = await reportTriageGoldens(
			[loadTriageGoldens()[0]!],
			triage.review,
			"faux/faux-1",
			1,
			"0".repeat(64),
			(line) => {
				printed.push(line);
			},
			() => {},
			undefined,
			mode.thinking,
		);
		expect(measurement.toJSON()).toMatchObject({ thinking: "minimal" });
		expect(printed.join("\n")).toContain("thinking minimal");
		expect(printed.join("\n")).toContain("requested=minimal");
		const raw = vi.spyOn(triage.models, "complete").mockImplementation(async (model, request, options) => {
			expect(options).not.toHaveProperty("reasoning");
			return direct.getMockImplementation()!(model, request);
		});
		try {
			await runTriageGolden(loadTriageGoldens()[0]!, { kind: "live", models: triage.review, model: "faux/faux-1" });
			expect(raw).toHaveBeenCalledOnce();
		} finally {
			raw.mockRestore();
		}
	} finally {
		direct.mockRestore();
	}

	expect(received).toEqual([
		{ reasoning: { effort: "minimal" } },
		{ reasoning: { effort: "minimal" } },
		{ reasoning: { effort: undefined } },
	]);
}, 60_000);

it.each([
	[undefined, true],
	["faux/judge", true],
	[undefined, false],
] as const)(
	"keeps configured verifier thinking when replacing its model with %s (configured=%s)",
	async (verifierModel, configured) => {
		const original = loadGoldens().find((golden) => golden.name === "correctness-null-deref")!;
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-verifier-thinking-")));
		cpSync(original.directory, directory, { recursive: true });
		writeFileSync(
			join(directory, "melian.golden.yaml"),
			"tiers:\n  full: [lens.correctness]\nmodels:\n  heavy:\n    model: faux/finder\n" +
				(configured ? "  verifier:\n    model: faux/configured\n    thinking: low\n" : ""),
		);
		const golden = { ...original, directory };
		const finding = original.script
			.correctness!.flatMap((reply) => ("calls" in reply ? reply.calls : []))
			.find((call) => call.name === "report_finding")!.arguments;
		const fake = createFakeModels({ models: [{ id: "finder" }, { id: "judge" }] });
		const received: { role: string; model: string; body: object }[] = [];
		fake.provider.setResponses(
			Array.from({ length: 10 }, () => async (request, options, _state, model) => {
				const prompt = systemPromptOf(request.messages);
				const verifier = prompt.includes("Melian adversarial verifier");
				const body = options?.reasoning === undefined ? {} : { reasoning: { effort: options.reasoning } };
				received.push({ role: verifier ? "verifier" : "finder", model: model.id, body });
				await options?.onPayload?.(body, model);
				if (verifier) return scriptVerifier(request.messages);
				expect(prompt).toContain("correctness reviewer");
				return request.messages.some((message) => message.role === "toolResult")
					? fauxAssistantMessage("Done.")
					: fauxAssistantMessage(fauxToolCall("report_finding", finding as Parameters<typeof fauxToolCall>[1]), {
							stopReason: "toolUse",
						});
			}),
		);
		try {
			const run = await runGolden(golden, {
				kind: "live",
				models: fake.review,
				model: "faux/finder",
				...(verifierModel === undefined ? {} : { verifierModel }),
				thinking: EvalThinking.parse("heavy=medium"),
			});
			const finder = received.filter((request) => request.role === "finder");
			const verifier = received.filter((request) => request.role === "verifier");
			expect(finder.length).toBeGreaterThan(0);
			expect(verifier.length).toBeGreaterThan(0);
			expect(finder).toEqual(
				finder.map(() => ({ role: "finder", model: "finder", body: { reasoning: { effort: "medium" } } })),
			);
			expect(verifier).toEqual(
				verifier.map(() => ({
					role: "verifier",
					model: verifierModel === undefined ? "finder" : "judge",
					body: configured ? { reasoning: { effort: "low" } } : {},
				})),
			);
			expect(run.findings).toHaveLength(1);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	60000,
);

it.each([
	["    thinking: high\n", "finder"],
	["    model: faux/configured\n    thinking: high\n", "configured"],
	["    accept: [faux/configured]\n    thinking: high\n", "configured"],
] as const)(
	"fills an unrouted live tier while keeping configured routing: %s",
	async (route, expectedModel) => {
		const original = loadGoldens().find((golden) => golden.name === "correctness-null-deref")!;
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-golden-tier-thinking-")));
		cpSync(original.directory, directory, { recursive: true });
		writeFileSync(
			join(directory, "melian.golden.yaml"),
			`tiers:\n  full: [lens.correctness]\nmodels:\n  heavy:\n${route}`,
		);
		const fake = createFakeModels({ models: [{ id: "finder" }, { id: "configured" }] });
		const received: { model: string; body: object }[] = [];
		fake.provider.setResponses([
			async (request, options, _state, model) => {
				expect(systemPromptOf(request.messages)).toContain("correctness reviewer");
				const body = { reasoning: { effort: options?.reasoning } };
				received.push({ model: model.id, body });
				await options?.onPayload?.(body, model);
				return fauxAssistantMessage("Done.");
			},
		]);
		try {
			await runGolden({ ...original, directory }, { kind: "live", models: fake.review, model: "faux/finder" });
			expect(received).toEqual([{ model: expectedModel, body: { reasoning: { effort: "high" } } }]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	60_000,
);

it("replaces a configured tier with the scripted model and leaves live thinking out", async () => {
	const original = loadGoldens().find((golden) => golden.name === "correctness-null-deref")!;
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-golden-scripted-route-")));
	cpSync(original.directory, directory, { recursive: true });
	writeFileSync(
		join(directory, "melian.golden.yaml"),
		"tiers:\n  full: [lens.correctness]\nmodels:\n  heavy:\n    model: faux/configured\n    thinking: high\n",
	);
	try {
		const result = await runGolden({ ...original, directory }, { kind: "scripted" });
		expect(result.findings).toHaveLength(1);
		expect(result.toolMismatches).toEqual([]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 60_000);
