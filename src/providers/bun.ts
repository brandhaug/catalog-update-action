import { Option, Schema } from 'effect'
import {
	readStringRecord,
	readJsonObject,
	parseJsonDocument,
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
	const workspaces = readJsonObject(pkg.workspaces)
	const topLevelCatalogs = readJsonObject(pkg.catalogs)
	const nestedCatalogs = readJsonObject(workspaces?.catalogs)

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
		const child = readJsonObject(result[head])
		if (child) {
			result[head] = withCatalogUpdates(child, path.slice(1), updates)
		}
	}
	return result
}

/** Parse a package.json document, returning undefined when it is not JSON. */
function parsePackageJson({
	content
}: {
	content: string
}): JsonObject | undefined {
	const parsed = parseJsonDocument(content)
	if (Option.isNone(parsed)) {
		return undefined
	}
	return readJsonObject(parsed.value)
}

export function parseBunCatalogs({
	content
}: {
	content: string
}): Array<ParsedCatalog> {
	const pkg = parsePackageJson({ content })
	if (!pkg) {
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
	const pkg = parsePackageJson({ content })
	if (!pkg) {
		// Provider functions may throw by contract: the BranchUpdate apply
		// adapters wrap every call in Effect.try and map the throw into a
		// typed BranchApplyError.
		// oxlint-disable-next-line effect/noThrowStatement, effect/noNewError
		throw new Error('Invalid package.json')
	}

	const section = catalogSections(pkg).find(
		(candidate) => candidate.catalogName === catalogName
	)
	if (!section) {
		// oxlint-disable-next-line effect/noThrowStatement, effect/noNewError
		throw new Error(`No catalog "${catalogName}" found in package.json`)
	}

	const updated = withCatalogUpdates(pkg, section.path, updates)
	// Definition files are rewritten in the exact 2-space + trailing-newline
	// format the package managers themselves emit, which a Schema encoder
	// would not reproduce byte-for-byte.
	// oxlint-disable-next-line effect/noGlobals
	return `${JSON.stringify(updated, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Validate a `bun audit --json` advisory entry before trusting its fields. */
const bunAdvisorySchema = Schema.Struct({
	id: Schema.Number,
	url: Schema.String,
	title: Schema.String,
	severity: severitySchema,
	vulnerable_versions: Schema.String,
	cwe: Schema.Array(Schema.String),
	cvss: Schema.Struct({ score: Schema.Number, vectorString: Schema.String })
})

const bunAuditResultSchema = Schema.Record(
	Schema.String,
	Schema.Array(bunAdvisorySchema)
)

/** bun audit reports advisories grouped by package name, matching AuditResult. */
function parseBunAuditOutput({
	output
}: {
	output: string
}): AuditResult | null {
	const parsed = parseJsonDocument(output)
	if (Option.isNone(parsed)) {
		return null
	}
	const result = Schema.decodeUnknownResult(bunAuditResultSchema)(parsed.value)
	if (result._tag === 'Failure') {
		return null
	}
	// Schema records and arrays are readonly; the pipeline builds mutable
	// advisory lists.
	const auditResult: AuditResult = {}
	for (const [packageName, advisories] of Object.entries(result.success)) {
		auditResult[packageName] = advisories.map((advisory) => ({
			id: advisory.id,
			url: advisory.url,
			title: advisory.title,
			severity: advisory.severity,
			vulnerable_versions: advisory.vulnerable_versions,
			cwe: [...advisory.cwe],
			cvss: {
				score: advisory.cvss.score,
				vectorString: advisory.cvss.vectorString
			}
		}))
	}
	return auditResult
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
