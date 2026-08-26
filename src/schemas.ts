import { z } from 'zod'

/** A closed JSON value: any JSON data, recursively. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
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
