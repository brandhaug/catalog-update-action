import { parse as parseYaml, parseDocument } from 'yaml'
import { readStringRecord, packageJsonSchema, type JsonValue } from '../schemas'
import { buildCatalogValue } from '../catalog'
import { type UpdateCandidate } from '../types'
import { type ParsedCatalog } from './types'

/** Both pnpm and yarn name their default catalog via a singular `catalog` key. */
export const DEFAULT_CATALOG = 'default'

/**
 * Check a value is a `Record<string, Record<string, string>>` (the shape of
 * the `catalogs` field in both pnpm-workspace.yaml and .yarnrc.yml).
 */
function readNamedCatalogs(
	value: JsonValue | undefined
): Record<string, Record<string, string>> | undefined {
	const parsed = packageJsonSchema.safeParse(value)
	if (!parsed.success) {
		return undefined
	}
	const result: Record<string, Record<string, string>> = {}
	for (const [name, entries] of Object.entries(parsed.data)) {
		const record = readStringRecord(entries)
		if (!record) {
			return undefined
		}
		result[name] = record
	}
	return result
}

/**
 * Parse catalog definitions shared by pnpm-workspace.yaml and .yarnrc.yml:
 * a singular `catalog` (the default catalog) and named `catalogs`. Entries
 * that are not plain strings are ignored rather than rejected, mirroring how
 * the JSON path tolerates malformed catalog values.
 */
export function parseYamlCatalogs({
	content
}: {
	content: string
}): Array<ParsedCatalog> {
	let root: Record<string, JsonValue>
	try {
		// Reuse the package.json document schema: both files are mappings of
		// arbitrary JSON values, so the same validation applies.
		const parsed = packageJsonSchema.safeParse(parseYaml(content))
		if (!parsed.success) {
			return []
		}
		root = parsed.data
	} catch {
		return []
	}

	const catalogs: Array<ParsedCatalog> = []

	const defaultCatalog = readStringRecord(root.catalog)
	if (defaultCatalog) {
		catalogs.push({ catalogName: DEFAULT_CATALOG, entries: defaultCatalog })
	}

	const named = readNamedCatalogs(root.catalogs)
	if (named) {
		for (const [name, entries] of Object.entries(named)) {
			// `catalogs.default` duplicates the singular `catalog`; the singular
			// field wins when both are present.
			if (name === DEFAULT_CATALOG && defaultCatalog) {
				continue
			}
			catalogs.push({ catalogName: name, entries })
		}
	}

	return catalogs
}

/**
 * Apply catalog updates to a YAML definition file, preserving comments,
 * blank lines and formatting via the yaml document round-trip. Missing
 * sections are created on demand.
 */
export function applyYamlCatalogUpdates({
	content,
	catalogName,
	updates
}: {
	content: string
	catalogName: string
	updates: Array<UpdateCandidate>
}): string {
	const doc = parseDocument(content)
	const firstError = doc.errors.at(0)
	if (firstError) {
		throw new Error(`Invalid YAML: ${String(firstError)}`)
	}

	const path =
		catalogName === DEFAULT_CATALOG ? ['catalog'] : ['catalogs', catalogName]

	for (const update of updates) {
		doc.setIn([...path, update.name], buildCatalogValue({ update }))
	}

	return doc.toString()
}

/** Extract a top-level string map (e.g. `overrides`) from YAML content. */
export function readYamlTopLevelMap({
	content,
	field
}: {
	content: string
	field: string
}): Record<string, string> | undefined {
	let root: Record<string, JsonValue>
	try {
		const parsed = packageJsonSchema.safeParse(parseYaml(content))
		if (!parsed.success) {
			return undefined
		}
		root = parsed.data
	} catch {
		return undefined
	}
	return readStringRecord(root[field])
}

/**
 * Rewrite a top-level YAML string map with the given contents, preserving
 * comments and the formatting of untouched entries. Keys removed from the
 * map are deleted; missing sections are created.
 */
export function writeYamlTopLevelMap({
	content,
	field,
	map
}: {
	content: string
	field: string
	map: Record<string, string>
}): string {
	const current = readYamlTopLevelMap({ content, field }) ?? {}
	const doc = parseDocument(content)
	const firstError = doc.errors.at(0)
	if (firstError) {
		throw new Error(`Invalid YAML: ${String(firstError)}`)
	}

	if (Object.keys(map).length === 0) {
		doc.deleteIn([field])
		return doc.toString()
	}

	for (const key of Object.keys(current)) {
		if (!(key in map)) {
			doc.deleteIn([field, key])
		}
	}
	for (const [key, value] of Object.entries(map)) {
		doc.setIn([field, key], value)
	}

	return doc.toString()
}
