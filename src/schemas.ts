import { z } from 'zod'

/** Severity levels shared by the audit pipeline and the config boundary. */
export const SEVERITIES = [
	'info',
	'low',
	'moderate',
	'high',
	'critical'
] as const
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

/** A raw package.json document: an object whose values are arbitrary JSON. */
export const packageJsonSchema = z.record(z.string(), jsonValueSchema)
export type PackageJson = z.infer<typeof packageJsonSchema>

/** An object whose values are all strings (catalog entries, override maps). */
export const stringRecordSchema = z.record(z.string(), z.string())

/**
 * Read a package.json field as a flat string map (catalog entries, override
 * maps), returning undefined when the field is missing or not a string record.
 */
export function readStringRecord(
	value: JsonValue
): Record<string, string> | undefined {
	const parsed = stringRecordSchema.safeParse(value)
	return parsed.success ? parsed.data : undefined
}
