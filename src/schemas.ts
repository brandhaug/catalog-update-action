import { Option, Schema } from 'effect'

/** Severity levels shared by the audit pipeline and the config boundary. */
export const severitySchema = Schema.Literals([
	'info',
	'low',
	'moderate',
	'high',
	'critical'
])
export type Severity = typeof severitySchema.Type

/** Semver change vocabulary shared by classification, grouping and ignore rules. */
export const semverChangeSchema = Schema.Literals([
	'major',
	'minor',
	'patch',
	'prerelease',
	'release'
])
export type SemverChange = typeof semverChangeSchema.Type

/** GitHub pull-request mergeability states. */
export const mergeableSchema = Schema.Literals([
	'MERGEABLE',
	'CONFLICTING',
	'UNKNOWN'
])
export type MergeableState = typeof mergeableSchema.Type

/** Merge methods the auto-merge step can arm. */
export const mergeMethodSchema = Schema.Literals(['squash', 'merge', 'rebase'])
export type MergeMethod = typeof mergeMethodSchema.Type

/**
 * A closed JSON value: any JSON data, recursively. Effect ships this as
 * `Schema.Json` (readonly view); the mutable alias below matches the shape the
 * transformation code builds.
 */
export type JsonValue = Schema.Json

/** Schema for a raw JSON object document: arbitrary JSON, object at the root. */
const jsonObjectSchema = Schema.Record(Schema.String, Schema.Json)
export type JsonObject = Record<string, JsonValue>

/**
 * Parse a JSON document, returning None instead of throwing on invalid input.
 */
export const parseJsonDocument = (input: string): Option.Option<unknown> =>
	// The repo's single JSON.parse codec: every raw JSON string flows through
	// here before any Schema decoding happens.
	// oxlint-disable-next-line effect/noGlobals
	Option.liftThrowable(JSON.parse)(input)

/**
 * Decode a raw JSON object document, returning a mutable copy on success and
 * undefined when the value is not an object of JSON values. The unknown-typed
 * parameter exists to have a Schema run over it on the next line.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function readJsonObject(value: unknown): JsonObject | undefined {
	const result = Schema.decodeUnknownOption(jsonObjectSchema)(value)
	return Option.isSome(result) ? { ...result.value } : undefined
}

/** Schema for a flat string map (catalog entries, override maps). */
const stringRecordSchema = Schema.Record(Schema.String, Schema.String)

/**
 * Read a value as a flat string map (catalog entries, override maps),
 * returning undefined when the value is not a string record. The unknown-typed
 * parameter exists to have a Schema run over it on the next line.
 */
export function readStringRecord(
	// oxlint-disable-next-line anti-slop/no-unknown-parameters
	value: unknown
): Record<string, string> | undefined {
	const result = Schema.decodeUnknownOption(stringRecordSchema)(value)
	return Option.isSome(result) ? { ...result.value } : undefined
}
