import { z } from 'zod'

/** Severity levels shared by the audit pipeline and the config boundary. */
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'] as const
export const severitySchema = z.enum(SEVERITIES)
export type Severity = z.infer<typeof severitySchema>

/** A closed JSON value: any JSON data, recursively. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| Array<JsonValue>
	| { [key: string]: JsonValue }

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(jsonValueSchema),
		z.record(z.string(), jsonValueSchema)
	])
)

/** A raw JSON object document: an object whose values are arbitrary JSON. */
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema)
export type JsonObject = z.infer<typeof jsonObjectSchema>

/** An object whose values are all strings (catalog entries, override maps). */
const stringRecordSchema = z.record(z.string(), z.string())

/**
 * Read an object field as a flat string map (catalog entries, override maps),
 * returning undefined when the field is missing or not a string record.
 */
export function readStringRecord(
	value: JsonValue | undefined
): Record<string, string> | undefined {
	const parsed = stringRecordSchema.safeParse(value)
	return parsed.success ? parsed.data : undefined
}
