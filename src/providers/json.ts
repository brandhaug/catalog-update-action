import { readStringRecord, jsonObjectSchema, type JsonObject } from '../schemas'

/** Read a top-level string map (e.g. `overrides`, `resolutions`) from JSON content. */
export function readJsonStringMap({
	content,
	field
}: {
	content: string
	field: string
}): Record<string, string> | undefined {
	try {
		const parsed = jsonObjectSchema.safeParse(JSON.parse(content))
		if (!parsed.success) {
			return undefined
		}
		return readStringRecord(parsed.data[field])
	} catch {
		return undefined
	}
}

/**
 * Rewrite a top-level string map in JSON content, preserving all other
 * fields. An empty map deletes the field entirely.
 */
export function writeJsonStringMap({
	content,
	field,
	map
}: {
	content: string
	field: string
	map: Record<string, string>
}): string {
	const doc: JsonObject = JSON.parse(content)
	if (Object.keys(map).length > 0) {
		return `${JSON.stringify({ ...doc, [field]: map }, null, 2)}\n`
	}
	// An empty map removes the field entirely.
	const rest: JsonObject = {}
	for (const [key, value] of Object.entries(doc)) {
		if (key !== field) {
			rest[key] = value
		}
	}
	return `${JSON.stringify(rest, null, 2)}\n`
}
