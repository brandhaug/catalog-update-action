import { Option } from 'effect'
import {
	readStringRecord,
	readJsonObject,
	parseJsonDocument,
	type JsonObject
} from '../schemas'

/** Read a top-level string map (e.g. `overrides`, `resolutions`) from JSON content. */
export function readJsonStringMap({
	content,
	field
}: {
	content: string
	field: string
}): Record<string, string> | undefined {
	const parsed = parseJsonDocument(content)
	if (Option.isNone(parsed)) {
		return undefined
	}
	const doc = readJsonObject(parsed.value)
	if (!doc) {
		return undefined
	}
	return readStringRecord(doc[field])
}

/**
 * Rewrite a top-level string map in JSON content, preserving all other
 * fields. An empty map deletes the field entirely.
 *
 * Throws on invalid JSON: callers apply this inside a BranchUpdate apply
 * effect, which maps the failure into the rollback path.
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
	// Throws on invalid JSON by contract: callers apply this inside a
	// BranchUpdate apply effect, which maps the failure into the rollback path.
	// oxlint-disable-next-line effect/noGlobals
	const doc: JsonObject = JSON.parse(content)
	if (Object.keys(map).length > 0) {
		// Definition files are rewritten in the exact 2-space + trailing-newline
		// format the package managers themselves emit, which a Schema encoder
		// would not reproduce byte-for-byte.
		// oxlint-disable-next-line effect/noGlobals
		return `${JSON.stringify({ ...doc, [field]: map }, null, 2)}\n`
	}
	// An empty map removes the field entirely.
	const rest: JsonObject = {}
	for (const [key, value] of Object.entries(doc)) {
		if (key !== field) {
			rest[key] = value
		}
	}
	// oxlint-disable-next-line effect/noGlobals
	return `${JSON.stringify(rest, null, 2)}\n`
}
