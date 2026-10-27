import { createHash } from "node:crypto";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { canonicalPath } from "./findings.ts";

/** Recurring survivor labels used by the builder's checklist and deterministic sample. */
export const survivorClasses = [
	"optional-chain",
	"seeded-default",
	"nullish-logical",
	"compound-condition",
	"some-every",
	"numeric-bound",
	"dropped-value",
	"negative-test",
] as const;

const strict = { additionalProperties: false };
const text = Type.String({ pattern: "\\S" });
const coordinate = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const line = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const identity = {
	file: text,
	line,
	column: coordinate,
	endLine: line,
	endColumn: coordinate,
	mutatorName: text,
	replacement: Type.String(),
};
const claim = Type.Union([Type.Literal("killed"), Type.Literal("new-test"), Type.Literal("equivalent")]);
const classes = Type.Array(Type.Enum(survivorClasses));
const testIdentity = Type.Object({ file: text, path: Type.Array(text, { minItems: 1 }) }, strict);
const evidence = Type.Union([Type.Object({ test: testIdentity }, strict), Type.Object({ reason: text }, strict)]);
const rowSchema = Type.Object(
	{
		id: digest,
		...identity,
		status: Type.Union([Type.Literal("generated"), Type.Literal("ignored")]),
		ignoredBy: Type.Optional(Type.Union([Type.Literal("config"), Type.Literal("comment")])),
		statusReason: Type.Optional(Type.String()),
		claim: Type.Optional(claim),
		evidence: Type.Optional(evidence),
		survivorClasses: Type.Optional(classes),
	},
	strict,
);
const unmutated = Type.Array(Type.Object({ file: text, reason: text }, strict));
const counts = { total: coordinate, omitted: coordinate, unmutated };
const inventorySchema = Type.Object(
	{
		melianMutants: Type.Literal(2),
		range: Type.Object(
			{
				base: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
				head: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
				target: Type.Optional(text),
			},
			strict,
		),
		adapters: Type.Array(
			Type.Object(
				{
					name: text,
					version: text,
					toolVersion: text,
					source: Type.Union([Type.Literal("checkout"), Type.Literal("melian")]),
				},
				strict,
			),
		),
		installation: digest,
		mutants: Type.Array(rowSchema),
		...counts,
	},
	strict,
);
const inputSchema = Type.Object(
	{
		...Type.Omit(inventorySchema, ["melianMutants", "mutants"]).properties,
		mutants: Type.Array(Type.Omit(rowSchema, ["id"])),
	},
	strict,
);
const legacyRowSchema = Type.Object({
	...identity,
	id: Type.Optional(digest),
	status: Type.Optional(Type.String()),
	statusReason: Type.Optional(Type.String()),
	claim: Type.Optional(claim),
	evidence: Type.Optional(text),
	survivorClasses: Type.Optional(classes),
});
const legacySchema = Type.Object({
	melianMutants: Type.Optional(Type.Literal(1)),
	mutants: Type.Array(legacyRowSchema),
	...counts,
});

/** The source span and replacement that determine a mutant's identity. */
export type MutationIdentity = Pick<
	Static<typeof rowSchema>,
	"file" | "line" | "column" | "endLine" | "endColumn" | "mutatorName" | "replacement"
>;
/** An adapter and enumerator version that produced inventory rows. */
export type MutationAdapterIdentity = Static<typeof inventorySchema>["adapters"][number];
/** A component array from the runner, rather than its ambiguous fullName string. */
export type MutationTestIdentity = Static<typeof testIdentity>;
/** A claimed kill, a planned test, or a reason for equivalence. */
export type MutationClaim = Static<typeof claim>;
/** Structural evidence which future verification can resolve without parsing a display name. */
export type MutationEvidence = Static<typeof evidence>;
/** One builder-assigned recurring survivor class. */
export type MutationSurvivorClass = (typeof survivorClasses)[number];
/** A version-2 mutant, optionally classified by its builder. */
export type MutationInventoryRow = Static<typeof rowSchema>;
/** An enumerator's row before the inventory derives its content identity. */
export type MutationInventoryRowInput = Omit<MutationInventoryRow, "id">;
/** The current inventory's stored JSON. Verification records are reserved for the verification implementation. */
export type MutationInventoryV2 = Static<typeof inventorySchema>;
/** A historical inventory accepted only for deterministic sampling. */
export type LegacyMutationInventory = Static<typeof legacySchema>;
/** An inventory at a supported version, without upgrading legacy claim evidence. */
export type MutationInventoryState = MutationInventoryV2 | LegacyMutationInventory;
/** Enumerated rows and provenance before version and mutant ids are assigned. */
export type MutationInventoryInput = Omit<MutationInventoryV2, "melianMutants" | "mutants"> & {
	mutants: MutationInventoryRowInput[];
};
/** A reproducible set of probes ordered by the full mutant identity's hash. */
export type MutationSample = {
	selected: ((MutationInventoryRow | LegacyMutationInventory["mutants"][number]) & { sampleHash: string })[];
	total: number;
	unmutated: MutationInventoryV2["unmutated"];
};
/** Why an inventory cannot be read, sampled or used for verification. */
export type MutationInventoryErrorCode =
	| "invalidInventory"
	| "unsupportedVersion"
	| "invalidIdentity"
	| "duplicateIdentity"
	| "incompleteInventory"
	| "unclassifiedClaim"
	| "invalidEvidence"
	| "legacyInventory";

/** An inventory refusal with a stable machine-readable reason. */
export class MutationInventoryError extends Error {
	readonly code: MutationInventoryErrorCode;
	constructor(code: MutationInventoryErrorCode, message: string) {
		super(message);
		this.name = "MutationInventoryError";
		this.code = code;
	}
}

function identityHash(row: MutationIdentity): string {
	return createHash("sha256")
		.update(
			JSON.stringify([row.file, row.line, row.column, row.endLine, row.endColumn, row.mutatorName, row.replacement]),
		)
		.digest("hex");
}

function requireRepositoryPath(file: string): void {
	let canonical: string;
	try {
		canonical = canonicalPath(file);
	} catch {
		throw new MutationInventoryError("invalidInventory", `invalid inventory file path: ${JSON.stringify(file)}`);
	}
	if (canonical !== file || file.includes("\0") || /^[A-Za-z]:/.test(file))
		throw new MutationInventoryError("invalidInventory", `invalid inventory file path: ${JSON.stringify(file)}`);
}

/** A versioned enumeration and its builder's claims; sampling never executes repository code. */
export class MutationInventory<State extends MutationInventoryState = MutationInventoryState> {
	readonly #state: State;

	private constructor(state: State) {
		this.#state = state;
	}

	/** Validates a stored inventory and retains legacy evidence without inventing a test identity. */
	static parse(input: unknown): MutationInventory {
		if (typeof input !== "object" || input === null)
			throw new MutationInventoryError("invalidInventory", "inventory must be an object");
		const version = "melianMutants" in input ? input.melianMutants : undefined;
		if (version !== undefined && version !== 1 && version !== 2)
			throw new MutationInventoryError("unsupportedVersion", "unsupported melianMutants inventory version");
		const schema = version === 2 ? inventorySchema : legacySchema;
		if (!Value.Check(schema, input))
			throw new MutationInventoryError(
				"invalidInventory",
				"invalid inventory fields, coordinates, claims, evidence or survivorClasses",
			);
		const state = structuredClone(input) as MutationInventoryState;
		if (state.total !== state.mutants.length + state.omitted)
			throw new MutationInventoryError(
				"invalidInventory",
				"inventory total must equal listed mutants plus omitted mutants",
			);
		const ids = new Set<string>();
		for (const row of state.mutants) {
			if (row.endLine < row.line || (row.endLine === row.line && row.endColumn < row.column))
				throw new MutationInventoryError("invalidIdentity", "mutant end coordinates precede its start");
			const id = identityHash(row);
			if (row.id !== undefined && row.id !== id)
				throw new MutationInventoryError("invalidIdentity", "mutant id does not match its identity fields");
			if (ids.has(id)) throw new MutationInventoryError("duplicateIdentity", `duplicate mutant identity: ${id}`);
			ids.add(id);
		}
		if (state.melianMutants === 2) {
			for (const { file } of state.unmutated) requireRepositoryPath(file);
			if (state.mutants.length > 0 && state.adapters.length === 0)
				throw new MutationInventoryError("invalidInventory", "nonempty inventory requires an adapter identity");
			if (new Set(state.adapters.map((adapter) => adapter.name)).size !== state.adapters.length)
				throw new MutationInventoryError("invalidInventory", "duplicate adapter identity names");
			for (const row of state.mutants) {
				requireRepositoryPath(row.file);
				if (row.evidence !== undefined && "test" in row.evidence) requireRepositoryPath(row.evidence.test.file);
				if ((row.status === "ignored") !== (row.ignoredBy !== undefined))
					throw new MutationInventoryError(
						"invalidInventory",
						"only ignored mutants require ignoredBy: config or comment",
					);
				if (row.claim === undefined) {
					if (row.evidence !== undefined)
						throw new MutationInventoryError("invalidEvidence", "evidence requires a classified claim");
				} else {
					if (row.evidence === undefined || (row.claim === "equivalent") !== "reason" in row.evidence)
						throw new MutationInventoryError(
							"invalidEvidence",
							"claim evidence must name a structural test or an equivalence reason",
						);
					if (row.survivorClasses === undefined)
						throw new MutationInventoryError("invalidInventory", "each claim needs survivorClasses");
				}
			}
		}
		return new MutationInventory(state);
	}

	/** Derives stable ids for enumerator rows and validates the version-2 document. */
	static create(input: MutationInventoryInput): MutationInventory<MutationInventoryV2> {
		if (!Value.Check(inputSchema, input))
			throw new MutationInventoryError(
				"invalidInventory",
				"invalid inventory input fields, coordinates, claims, evidence or survivorClasses",
			);
		return MutationInventory.parse({
			melianMutants: 2,
			...input,
			mutants: input.mutants.map((row) => ({ ...row, id: identityHash(row) })),
		}) as MutationInventory<MutationInventoryV2>;
	}

	/** Chooses the same hashes, mandatory groups and per-file rounded fifth as the historical script. */
	sample(): MutationSample {
		this.#requireClassified();
		const ranked = this.#state.mutants
			.map((mutant) => ({ mutant, hash: identityHash(mutant) }))
			.sort((a, b) => a.hash.localeCompare(b.hash));
		const selected = new Set(ranked.filter((row) => row.mutant.claim !== "killed"));
		const classGroups = Map.groupBy(
			ranked.flatMap((row) => row.mutant.survivorClasses!.map((name) => ({ name, row }))),
			(member) => member.name,
		);
		const groups = [
			...Map.groupBy(ranked, (row) => row.mutant.file).values(),
			...Map.groupBy(ranked, (row) => row.mutant.mutatorName).values(),
			...[...classGroups.values()].map((group) => group.map((member) => member.row)),
		];
		for (const group of groups) if (group.every((row) => !selected.has(row))) selected.add(group[0]);
		const remaining = Map.groupBy(
			ranked.filter((row) => !selected.has(row)),
			(row) => row.mutant.file,
		);
		for (const group of remaining.values())
			for (const row of group.slice(0, Math.ceil(group.length / 5))) selected.add(row);
		return structuredClone({
			selected: ranked.filter((row) => selected.has(row)).map((row) => ({ ...row.mutant, sampleHash: row.hash })),
			total: this.#state.total,
			unmutated: this.#state.unmutated,
		});
	}

	/** Refuses legacy strings and incomplete claims before a future verifier executes anything. */
	forVerification(): MutationInventoryV2 {
		if (this.#state.melianMutants !== 2)
			throw new MutationInventoryError(
				"legacyInventory",
				"legacy inventory evidence cannot identify a test; enumerate again",
			);
		this.#requireClassified();
		return structuredClone(this.#state as MutationInventoryV2);
	}

	/** Returns an owned copy in the document's original version. */
	toJSON(): State {
		return structuredClone(this.#state);
	}

	/** Renders full identities and ignored provenance without treating statusReason as policy. */
	renderTable(): string {
		const state = this.#state;
		return [
			"ID\tFILE\tLINE\tCOLUMN\tEND_LINE\tEND_COLUMN\tMUTATOR\tREPLACEMENT\tPOLICY",
			...state.mutants.map((row) =>
				[
					identityHash(row),
					JSON.stringify(row.file),
					row.line,
					row.column,
					row.endLine,
					row.endColumn,
					JSON.stringify(row.mutatorName).slice(1, -1),
					JSON.stringify(row.replacement),
					JSON.stringify({
						status: row.status,
						...("ignoredBy" in row ? { ignoredBy: row.ignoredBy } : {}),
						statusReason: row.statusReason,
					}),
				].join("\t"),
			),
			...state.unmutated.map(({ file, reason }) => `UNMUTATED\t${JSON.stringify(file)}\t${JSON.stringify(reason)}`),
			"",
			`${state.mutants.length} of ${state.total} mutants; ${state.omitted} omitted`,
		].join("\n");
	}

	#requireClassified(): void {
		if (this.#state.omitted !== 0)
			throw new MutationInventoryError(
				"incompleteInventory",
				"sampling and verification require a complete inventory with no omitted mutants",
			);
		for (const row of this.#state.mutants) {
			if (row.claim === undefined)
				throw new MutationInventoryError(
					"unclassifiedClaim",
					"each mutant needs a claim: killed, new-test or equivalent",
				);
			if (row.evidence === undefined)
				throw new MutationInventoryError(
					"invalidEvidence",
					"each claim needs evidence: a named test or an equivalence reason",
				);
			if (row.survivorClasses === undefined)
				throw new MutationInventoryError("invalidInventory", "each claim needs survivorClasses");
		}
	}
}
