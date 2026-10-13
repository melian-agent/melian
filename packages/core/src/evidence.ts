import Type from "typebox";

// The schemas findings and verification records share. They live apart so neither module imports the other's values.

const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });
const line = Type.Integer({ minimum: 1 });

/** The JSON Schema of a {@link Cause}. */
export const causeSchema = Type.Union([
	Type.Literal("introduced"),
	Type.Literal("affected"),
	Type.Literal("pre-existing"),
]);

/** The JSON Schema of an {@link EvidenceRole}. */
export const evidenceRoleSchema = Type.Union([Type.Literal("cause"), Type.Literal("context")]);

/** The JSON Schema of an {@link EvidenceRevision}. */
export const evidenceRevisionSchema = Type.Union([Type.Literal("head"), Type.Literal("base")]);

/** The JSON Schema of an {@link EvidenceLocation}. */
export const evidenceLocationSchema = Type.Object(
	{
		file: text,
		startLine: line,
		endLine: Type.Optional(line),
		role: evidenceRoleSchema,
		revision: evidenceRevisionSchema,
		deleted: Type.Optional(Type.Literal(true)),
		proves: Type.Optional(Type.Literal(true)),
		snippet: text,
	},
	strict,
);

/** The JSON Schema of {@link FindingEvidence}. */
export const findingEvidenceSchema = Type.Array(evidenceLocationSchema, { minItems: 1 });
