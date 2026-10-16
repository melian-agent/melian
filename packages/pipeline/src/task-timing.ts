import { type Context, type ConversationId, defineDocFamily, type TaskId, type Tx } from "./harness.ts";

// Pi retires task-scoped documents at settlement; each family member belongs to one task.
export const TimingDocument = defineDocFamily<{ startedAt?: number; endedAt?: number; legacy?: true }, null>({
	kind: "melian.stage-timing",
	family: true,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({}),
});

type Clock = {
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	now(): number;
	commit(change: (tx: Tx) => Promise<undefined>, context: Context): Promise<void>;
	memo(name: string, context: Context): Promise<number | null | undefined>;
	memo(name: string, candidate: number | null, context: Context): Promise<number | null>;
};

export class TaskTiming {
	private readonly clock: Clock;
	private readonly startedAt: number | null | undefined;

	private constructor(clock: Clock, startedAt: number | null | undefined) {
		this.clock = clock;
		this.startedAt = startedAt;
	}

	static async start(clock: Clock, legacy: true | undefined, context: Context): Promise<TaskTiming> {
		const timing = new TaskTiming(
			clock,
			await clock.memo("telemetry.start", legacy === true ? null : clock.now(), context),
		);
		if (legacy === true)
			await clock.commit(async (tx) => {
				(await tx.doc(TimingDocument, clock.conversationId, String(clock.taskId), null)).legacy = true;
			}, context);
		return timing;
	}

	static async read(clock: Clock, context: Context): Promise<TaskTiming> {
		return new TaskTiming(clock, await clock.memo("telemetry.start", context));
	}

	async end(tx: Tx): Promise<void> {
		const timing = await tx.doc(TimingDocument, this.clock.conversationId, String(this.clock.taskId), null);
		if (typeof this.startedAt === "number") timing.startedAt = this.startedAt;
		timing.endedAt = this.clock.now();
	}
}
