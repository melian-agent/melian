/**
 * One stage of a review's run, projected from its stored telemetry. Durations are in milliseconds and cost in US
 * dollars. `outcome` is `ran`, `reused`, `skipped`, `failed`, `ended`, `timed-out`, `provisional` or `running`.
 */
export type RunStage = {
	name: string;
	level?: string;
	/** Each model as the table names it: its ID, the reasoning level requested, and the level reported if it differs. */
	models: string[];
	durationMs?: number;
	tokens?: number;
	cacheRead?: number;
	cost?: number;
	outcome: string;
	/** Tool calls a lens's tools budget counted. */
	tools?: number;
	/** A lens level's token and tool budgets. */
	limits?: { tokens?: number; tools?: number };
	/** The budget that ended a lens. */
	ended?: "tokens" | "tools";
	/** A model stage some of whose requests left no usage, so its tokens and cost are a floor. */
	usageIncomplete?: true;
};

/** A review's run as the ledger stores it: the review's wall clock, when its spans recorded one, and its stages. */
export type StoredRunDetails = { durationMs?: number; stages: RunStage[] };

/** One row of the run table, every cell as plain text a renderer escapes. */
export type RunRow = {
	stage: string;
	level: string;
	model: string;
	time: string;
	tokens: string;
	cost: string;
	outcome: string;
	budget: string;
};

/** A token count: whole below a thousand, then thousands, then millions. */
export function tokenText(count: number): string {
	if (count < 1000) return String(count);
	if (count < 9_950) return `${(count / 1000).toFixed(1)}k`;
	if (count < 999_500) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(2)}M`;
}

/** A cost in dollars and cents; a cost that rounds to nothing but is not nothing says so. */
export function costText(dollars: number): string {
	if (dollars > 0 && dollars < 0.005) return "<$0.01";
	return `$${dollars.toFixed(2)}`;
}

/** A duration in seconds below five minutes, and in minutes from five. */
export function durationText(ms: number): string {
	if (ms < 9_950) return `${(ms / 1000).toFixed(1)} s`;
	if (ms < 299_500) return `${Math.round(ms / 1000)} s`;
	return `${(ms / 60_000).toFixed(1)} min`;
}

// A budget is worth naming from four fifths of its limit.
const near = (used: number, limit: number | undefined) => limit !== undefined && used * 5 >= limit * 4;

function tokensOf(stage: RunStage): string {
	const counted = stage.tokens === undefined ? [] : [tokenText(stage.tokens)];
	const parts = [...counted, ...(stage.usageIncomplete ? ["incomplete"] : [])];
	return parts.length === 0 ? "—" : parts.join(", ");
}

function budgetOf(stage: RunStage): string {
	const tools = stage.tools ?? 0;
	const tokens = (stage.tokens ?? 0) - (stage.cacheRead ?? 0);
	const { limits = {} } = stage;
	const used = { tools: String(tools), tokens: tokenText(tokens) };
	const limit = { tools: limits.tools, tokens: limits.tokens === undefined ? undefined : tokenText(limits.tokens) };
	if (stage.ended !== undefined) {
		const of = limit[stage.ended];
		return `${stage.ended} budget ended it${of === undefined ? "" : `: ${used[stage.ended]} / ${of}`}`;
	}
	return [
		...(near(tools, limits.tools) ? [`tools ${tools} / ${limits.tools}`] : []),
		...(near(tokens, limits.tokens) ? [`tokens ${used.tokens} / ${limit.tokens}`] : []),
	].join("; ");
}

/** A review's run, read back from the ledger's store: one summary line and a row per stage. */
export class RunDetails {
	readonly durationMs?: number;
	readonly stages: readonly RunStage[];

	private constructor(stored: StoredRunDetails) {
		if (stored.durationMs !== undefined) this.durationMs = stored.durationMs;
		this.stages = stored.stages;
	}

	static from(stored: StoredRunDetails): RunDetails {
		return new RunDetails(structuredClone(stored));
	}

	/** Time, tokens with their cache share, cost, and each model once. A reused stage cost this review nothing. */
	summary(): string {
		const own = this.stages.filter((stage) => stage.outcome !== "reused");
		const tokens = own.reduce((sum, stage) => sum + (stage.tokens ?? 0), 0);
		const cached = own.reduce((sum, stage) => sum + (stage.cacheRead ?? 0), 0);
		const cost = own.reduce((sum, stage) => sum + (stage.cost ?? 0), 0);
		const models = [...new Set(own.flatMap((stage) => stage.models))];
		const qualified = [
			...(tokens === 0 ? [] : [`${Math.round((cached / tokens) * 100)}% cached`]),
			...(own.some((stage) => stage.usageIncomplete) ? ["incomplete"] : []),
		];
		return [
			...(this.durationMs === undefined ? [] : [durationText(this.durationMs)]),
			`${tokenText(tokens)} tokens${qualified.length === 0 ? "" : ` (${qualified.join(", ")})`}`,
			costText(cost),
			...(models.length === 0 ? [] : [models.join(", ")]),
		].join(" · ");
	}

	/** One row per stage. A budget shows only near or at its limit, or when it ended the lens. */
	rows(): RunRow[] {
		return this.stages.map((stage) => {
			const reused = stage.outcome === "reused";
			return {
				stage: stage.name,
				level: stage.level ?? "",
				model: stage.models.join(", "),
				time: reused || stage.durationMs === undefined ? "—" : durationText(stage.durationMs),
				tokens: reused ? "—" : tokensOf(stage),
				cost: reused ? "$0.00" : stage.cost === undefined ? "—" : costText(stage.cost),
				outcome: stage.outcome,
				budget: reused ? "" : budgetOf(stage),
			};
		});
	}

	/** Whether any stage has a token budget, so the table says what one counts. */
	hasTokenBudget(): boolean {
		return this.stages.some((stage) => stage.limits?.tokens !== undefined);
	}

	toJSON(): StoredRunDetails {
		return {
			...(this.durationMs === undefined ? {} : { durationMs: this.durationMs }),
			stages: structuredClone([...this.stages]),
		};
	}
}
