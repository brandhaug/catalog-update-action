import { z } from 'zod'
import {
	readStringRecord,
	jsonObjectSchema,
	severitySchema,
	type JsonObject,
	type JsonValue
} from '../schemas'
import { buildCatalogValue } from '../catalog'
import { isToolOverrideKey, overrideKey } from '../utils'
import { type AuditResult, type UpdateCandidate } from '../types'
import {
	DEFAULT_CATALOG,
	type AuditCapability,
	type ParsedCatalog
} from './types'
import { readJsonStringMap, writeJsonStringMap } from './json'

/** Validate a value as a JSON object, returning a parsed copy. */
function readObject(value: JsonValue | undefined): JsonObject | undefined {
	const parsed = jsonObjectSchema.safeParse(value)
	return parsed.success ? parsed.data : undefined
}

/**
 * Bun defines catalogs as `catalog` (default) and `catalogs.<name>` at the
 * top level of package.json, or nested inside the `workspaces` object. All
 * four locations are equivalent; the singular fields win for the default
 * catalog when several define it.
 */
function catalogSections(pkg: JsonObject): Array<{
	catalogName: string
	path: Array<string>
	entries: Record<string, string>
}> {
	const workspaces = readObject(pkg.workspaces)
	const topLevelCatalogs = readObject(pkg.catalogs)
	const nestedCatalogs = readObject(workspaces?.catalogs)

	const sections: Array<{
		catalogName: string
		path: Array<string>
		entries: Record<string, string>
	}> = []

	// Named catalogs live under a `catalogs` key; anything else is the default.
	const consider = (
		path: Array<string>,
		value: JsonValue | undefined
	): void => {
		const entries = readStringRecord(value)
		if (!entries) {
			return
		}
		const isNamed = path.length >= 2 && path.at(-2) === 'catalogs'
		sections.push({
			catalogName: isNamed ? String(path.at(-1)) : DEFAULT_CATALOG,
			path,
			entries
		})
	}

	consider(['catalog'], pkg.catalog)
	consider(['workspaces', 'catalog'], workspaces?.catalog)
	consider(['catalogs', DEFAULT_CATALOG], topLevelCatalogs?.[DEFAULT_CATALOG])
	consider(
		['workspaces', 'catalogs', DEFAULT_CATALOG],
		nestedCatalogs?.[DEFAULT_CATALOG]
	)
	for (const name of Object.keys(topLevelCatalogs ?? {})) {
		if (name !== DEFAULT_CATALOG) {
			consider(['catalogs', name], topLevelCatalogs?.[name])
		}
	}
	for (const name of Object.keys(nestedCatalogs ?? {})) {
		if (name !== DEFAULT_CATALOG) {
			consider(['workspaces', 'catalogs', name], nestedCatalogs?.[name])
		}
	}

	return sections
}

/** Rebuild the tree along `path`, applying catalog updates at the leaf. */
function withCatalogUpdates(
	node: JsonObject,
	path: Array<string>,
	updates: Array<UpdateCandidate>
) {
	const result = { ...node }

	if (path.length === 0) {
		for (const update of updates) {
			result[update.name] = buildCatalogValue({ update })
		}
		return result
	}

	const head = path.at(0)
	if (head !== undefined) {
		const child = readObject(result[head])
		if (child) {
			result[head] = withCatalogUpdates(child, path.slice(1), updates)
		}
	}
	return result
}

export function parseBunCatalogs({
	content
}: {
	content: string
}): Array<ParsedCatalog> {
	let pkg: JsonObject
	try {
		const parsed = jsonObjectSchema.safeParse(JSON.parse(content))
		if (!parsed.success) {
			return []
		}
		pkg = parsed.data
	} catch {
		return []
	}

	const seen = new Set<string>()
	const catalogs: Array<ParsedCatalog> = []
	for (const section of catalogSections(pkg)) {
		if (seen.has(section.catalogName)) {
			continue
		}
		seen.add(section.catalogName)
		catalogs.push({
			catalogName: section.catalogName,
			entries: section.entries
		})
	}
	return catalogs
}

export function applyBunCatalogUpdates({
	content,
	catalogName,
	updates
}: {
	content: string
	catalogName: string
	updates: Array<UpdateCandidate>
}): string {
	let pkg: JsonObject
	try {
		const parsed = jsonObjectSchema.safeParse(JSON.parse(content))
		if (!parsed.success) {
			throw new Error('invalid package.json')
		}
		pkg = parsed.data
	} catch {
		throw new Error('Invalid package.json')
	}

	const section = catalogSections(pkg).find(
		(candidate) => candidate.catalogName === catalogName
	)
	if (!section) {
		throw new Error(`No catalog "${catalogName}" found in package.json`)
	}

	const updated = withCatalogUpdates(pkg, section.path, updates)
	return `${JSON.stringify(updated, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Validate a `bun audit --json` advisory entry before trusting its fields. */
const bunAdvisorySchema = z.object({
	id: z.number(),
	url: z.string(),
	title: z.string(),
	severity: severitySchema,
	vulnerable_versions: z.string(),
	cwe: z.array(z.string()),
	cvss: z.object({ score: z.number(), vectorString: z.string() })
})

const bunAuditResultSchema = z.record(z.string(), z.array(bunAdvisorySchema))

/** bun audit reports advisories grouped by package name, matching AuditResult. */
function parseBunAuditOutput({
	output
}: {
	output: string
}): AuditResult | null {
	try {
		const parsed = bunAuditResultSchema.safeParse(JSON.parse(output))
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

export const bunAudit: AuditCapability = {
	command: ['bun', 'audit', '--json'],
	parseOutput: parseBunAuditOutput,
	overrideFile: 'package.json',
	overrideField: 'overrides',
	overrideKey,
	isManagedOverride: (key) => isToolOverrideKey(key),
	readOverrides: ({ content }) =>
		readJsonStringMap({ content, field: 'overrides' }),
	writeOverrides: ({ content, map }) =>
		writeJsonStringMap({ content, field: 'overrides', map })
}
