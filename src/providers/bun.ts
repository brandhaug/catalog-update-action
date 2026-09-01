import { z } from 'zod'
import {
	readStringRecord,
	packageJsonSchema,
	severitySchema,
	type PackageJson,
	type JsonValue
} from '../schemas'
import { buildCatalogValue } from '../catalog'
import { isToolOverrideKey, overrideKey } from '../utils'
import { type AuditResult, type UpdateCandidate } from '../types'
import { type AuditCapability, type ParsedCatalog } from './types'

const DEFAULT_CATALOG = 'default'

/** Validate a value as a JSON object, returning a parsed copy. */
function readObject(
	value: JsonValue | undefined
): Record<string, JsonValue> | undefined {
	const parsed = packageJsonSchema.safeParse(value)
	return parsed.success ? parsed.data : undefined
}

/**
 * Bun defines catalogs as `catalog` (default) and `catalogs.<name>` at the
 * top level of package.json, or nested inside the `workspaces` object. All
 * four locations are equivalent; the singular fields win for the default
 * catalog when several define it.
 */
function catalogSectionPaths(pkg: PackageJson): Array<{
	catalogName: string
	path: Array<string>
}> {
	const workspaces = readObject(pkg.workspaces)
	const topLevelCatalogs = readObject(pkg.catalogs)
	const nestedCatalogs = readObject(workspaces?.catalogs)

	const paths: Array<{ catalogName: string; path: Array<string> }> = []

	// Named catalogs live under a `catalogs` key; anything else is the default.
	const consider = (path: Array<string>): void => {
		const isNamed = path.length >= 2 && path.at(-2) === 'catalogs'
		paths.push({
			catalogName: isNamed ? String(path.at(-1)) : DEFAULT_CATALOG,
			path
		})
	}

	const considerIfObject = (
		path: Array<string>,
		value: JsonValue | undefined
	): void => {
		if (readObject(value)) {
			consider(path)
		}
	}

	considerIfObject(['catalog'], pkg.catalog)
	considerIfObject(['workspaces', 'catalog'], workspaces?.catalog)
	considerIfObject(
		['catalogs', DEFAULT_CATALOG],
		topLevelCatalogs?.[DEFAULT_CATALOG]
	)
	considerIfObject(
		['workspaces', 'catalogs', DEFAULT_CATALOG],
		nestedCatalogs?.[DEFAULT_CATALOG]
	)

	const addNamed = (
		catalogs: Record<string, JsonValue> | undefined,
		prefix: Array<string>
	): void => {
		for (const name of Object.keys(catalogs ?? {})) {
			if (name === DEFAULT_CATALOG) {
				continue
			}
			considerIfObject([...prefix, 'catalogs', name], catalogs?.[name])
		}
	}
	addNamed(topLevelCatalogs, [])
	addNamed(nestedCatalogs, ['workspaces'])

	return paths
}

/** Rebuild the tree along `path`, applying catalog updates at the leaf. */
function withCatalogUpdates(
	node: Record<string, JsonValue>,
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
	let pkg: PackageJson
	try {
		const parsed = packageJsonSchema.safeParse(JSON.parse(content))
		if (!parsed.success) {
			return []
		}
		pkg = parsed.data
	} catch {
		return []
	}

	const seen = new Set<string>()
	const catalogs: Array<ParsedCatalog> = []
	for (const section of catalogSectionPaths(pkg)) {
		if (seen.has(section.catalogName)) {
			continue
		}
		// Resolve the section content by re-walking the tree so the entries
		// reflect the document actually being inspected.
		let node: Record<string, JsonValue> | undefined = pkg
		for (const key of section.path) {
			node = node && readObject(node[key])
		}
		const entries = readStringRecord(node)
		if (!entries) {
			continue
		}
		seen.add(section.catalogName)
		catalogs.push({ catalogName: section.catalogName, entries })
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
	let pkg: PackageJson
	try {
		const parsed = packageJsonSchema.safeParse(JSON.parse(content))
		if (!parsed.success) {
			throw new Error('invalid package.json')
		}
		pkg = parsed.data
	} catch {
		throw new Error('Invalid package.json')
	}

	const section = catalogSectionPaths(pkg).find(
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
export function parseBunAuditOutput({
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

function readJsonField({
	content,
	field
}: {
	content: string
	field: string
}): Record<string, string> | undefined {
	try {
		const parsed = packageJsonSchema.safeParse(JSON.parse(content))
		if (!parsed.success) {
			return undefined
		}
		return readStringRecord(parsed.data[field])
	} catch {
		return undefined
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
		readJsonField({ content, field: 'overrides' }),
	writeOverrides: ({ content, map }) => {
		const pkg: PackageJson = JSON.parse(content)
		if (Object.keys(map).length > 0) {
			pkg.overrides = map
		} else {
			delete pkg.overrides
		}
		return `${JSON.stringify(pkg, null, 2)}\n`
	}
}
