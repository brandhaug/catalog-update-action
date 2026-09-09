import { Option } from 'effect'
import {
	applyEdits,
	modify,
	type FormattingOptions,
	type JSONPath
} from 'jsonc-parser'
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
	const existing = readStringRecord(doc[field])
	let updated = content

	if (Object.keys(map).length === 0) {
		return existing === undefined
			? updated
			: applyJsonEdit(updated, [field], undefined)
	}

	if (existing === undefined) {
		return applyJsonEdit(updated, [field], map)
	}

	// Change only values that differ, then remove stale entries. Applying each
	// edit to the current source keeps offsets correct and preserves formatting.
	for (const [key, value] of Object.entries(map)) {
		if (existing[key] !== value) {
			updated = applyJsonEdit(updated, [field, key], value)
		}
	}
	for (const key of Object.keys(existing)) {
		if (!(key in map)) {
			updated = applyJsonEdit(updated, [field, key], undefined)
		}
	}

	return updated
}

/** Apply a JSON edit while using the surrounding document's indentation. */
export function applyJsonEdit(
	content: string,
	path: JSONPath,
	value: string | Record<string, string> | undefined
): string {
	return applyEdits(
		content,
		modify(content, path, value, {
			formattingOptions: detectFormatting(content)
		})
	)
}

function detectFormatting(content: string): FormattingOptions {
	const eol = content.includes('\r\n') ? '\r\n' : '\n'
	const indent = content
		.split(/\r?\n/)
		.map((line) => line.match(/^(\s+)\S/))
		.find((match) => match !== null)?.[1]

	if (indent?.includes('\t')) {
		return { insertSpaces: false, tabSize: 1, eol }
	}

	return {
		insertSpaces: true,
		tabSize: indent?.length || 2,
		eol
	}
}
