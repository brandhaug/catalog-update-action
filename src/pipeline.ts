import { DateTime, Effect, FileSystem, Option } from 'effect'

import { loadConfig } from './config'
import { buildCatalogValue, parseCatalog } from './catalog'
import {
	runAudit,
	computeOverrides,
	buildOverrideBranchUpdate,
	isOverrideBranchOutdated
} from './audit'
import {
	getExistingPrs,
	syncExistingPrs,
	createPr,
	buildCatalogBranchUpdate
} from './git'
import { getProvider, type ParsedCatalog } from './providers'
import { shouldIgnore, assignToGroups } from './groups'
import { Registry } from './registry'
import { filterByReleaseAge } from './release-age'
import { classifySemverChange, getOverrideBranchPrefix } from './utils'
import {
	type BranchUpdate,
	type CatalogEntry,
	type CatalogLocation,
	type Config,
	type DirectoryContext,
	type ExistingPr,
	type OverrideEntry,
	type UpdateCandidate,
	type VersionReleaseNote
} from './types'

// ---------------------------------------------------------------------------
// Per-catalog pipeline stages
// ---------------------------------------------------------------------------

/**
 * Everything the per-location stages share, computed once by processCatalog:
 * the directory context, the loaded config, the location itself, and the
 * branch-prefix/title decoration derived from them.
 */
type DirectoryRun = {
	dir: DirectoryContext
	config: Config
	location: CatalogLocation
	titleSuffix: string
	effectiveBranchPrefix: string
}

/**
 * DirectoryRun plus the computed update artifacts (stage 5/5b output) that
 * the PR sync and creation stages share.
 */
type CatalogRun = DirectoryRun & {
	groups: Map<string, Array<UpdateCandidate>>
	releaseNotes: Map<string, Array<VersionReleaseNote>>
	overrideBranchUpdate: BranchUpdate | null
	overrideEntries: Array<OverrideEntry>
}

/**
 * The catalog BranchUpdate builder for one run, shared by the sync and
 * create stages so both derive branches, titles and bodies identically.
 */
function makeCatalogBranchBuilder(catalog: CatalogRun) {
	return (groupName: string, updates: Array<UpdateCandidate>) =>
		buildCatalogBranchUpdate({
			groupName,
			updates,
			config: catalog.config,
			location: catalog.location,
			workDir: catalog.dir.workDir,
			titleSuffix: catalog.titleSuffix,
			branchPrefix: catalog.effectiveBranchPrefix,
			releaseNotes: catalog.releaseNotes
		})
}

function buildDirectoryContext({
	cwd,
	dir
}: {
	cwd: string
	dir: string
}): DirectoryContext {
	return {
		cwd,
		workDir: dir === '.' ? cwd : `${cwd}/${dir}`
	}
}

const loadConfigForDirectory = Effect.fn('Pipeline.loadConfigForDirectory')(
	function* ({
		dir,
		configPath
	}: {
		dir: DirectoryContext
		configPath: string
	}) {
		yield* Effect.logInfo('  Loading config...')
		const config = yield* loadConfig({
			configPath: `${dir.workDir}/${configPath}`
		})
		yield* Effect.logInfo(`    Branch prefix: ${config.branchPrefix}`)
		yield* Effect.logInfo(`    Default branch: ${config.defaultBranch}`)
		yield* Effect.logInfo(`    Groups: ${config.groups.length}`)
		yield* Effect.logInfo(`    Ignore rules: ${config.ignore.length}`)
		yield* Effect.logInfo(
			`    Audit: ${config.audit.enabled ? `enabled (minimum severity: ${config.audit.minimumSeverity})` : 'disabled'}`
		)
		if (config.minReleaseAgeDays > 0) {
			yield* Effect.logInfo(
				`    Min release age: ${config.minReleaseAgeDays} day(s)`
			)
		}
		return config
	}
)

const findCatalogCandidates = Effect.fn('Pipeline.findCatalogCandidates')(
	function* ({
		entries,
		config
	}: {
		entries: Array<CatalogEntry>
		config: Config
	}) {
		yield* Effect.logInfo('  Querying npm registry...')
		const registry = yield* Registry
		const latestVersions = yield* registry.queryNpmRegistry({
			entries,
			concurrency: config.concurrency
		})
		yield* Effect.logInfo(
			`    Got latest versions for ${latestVersions.size} packages`
		)

		yield* Effect.logInfo('  Finding available updates...')
		const candidates: Array<UpdateCandidate> = []

		for (const entry of entries) {
			const latest = latestVersions.get(entry.name)
			if (!latest) {
				continue
			}

			const changeType = classifySemverChange({
				from: entry.currentVersion,
				to: latest
			})
			if (changeType === null) {
				continue
			}

			if (
				shouldIgnore({ name: entry.name, changeType, rules: config.ignore })
			) {
				continue
			}

			candidates.push({ ...entry, latestVersion: latest, changeType })
		}

		yield* Effect.logInfo(
			`    Found ${candidates.length} packages with updates`
		)
		return candidates
	}
)

const buildGroupedUpdates = Effect.fn('Pipeline.buildGroupedUpdates')(
	function* ({
		candidates,
		config
	}: {
		candidates: Array<UpdateCandidate>
		config: Config
	}) {
		const groups = new Map<string, Array<UpdateCandidate>>()
		const releaseNotes = new Map<string, Array<VersionReleaseNote>>()
		if (candidates.length === 0) {
			return { candidates, groups, releaseNotes }
		}

		const registry = yield* Registry

		yield* Effect.logInfo('  Fetching package metadata...')
		const packageMetadata = yield* registry.queryPackageMetadata({
			candidates,
			concurrency: config.concurrency
		})
		yield* Effect.logInfo(
			`    Found metadata for ${packageMetadata.size}/${candidates.length} packages`
		)

		// Filter by minimum release age (supply chain protection)
		let remaining = candidates
		if (config.minReleaseAgeDays > 0) {
			yield* Effect.logInfo(
				`  Filtering by minimum release age (${config.minReleaseAgeDays} day(s))...`
			)
			const nowUtc = yield* DateTime.now
			const nowEpochMs = DateTime.toEpochMillis(nowUtc)
			const beforeCount = candidates.length
			const result = filterByReleaseAge({
				candidates,
				packageMetadata,
				minReleaseAgeDays: config.minReleaseAgeDays,
				nowEpochMs
			})
			remaining = result.candidates
			for (const event of result.events) {
				yield* Effect.logInfo(event.message)
			}
			const skipped = beforeCount - remaining.length
			if (skipped > 0) {
				yield* Effect.logInfo(
					`    Skipped ${skipped} package(s) due to release age`
				)
			}
		}

		yield* Effect.logInfo('  Fetching release notes...')
		const notes = yield* registry.queryReleaseNotes({
			candidates: remaining,
			packageMetadata,
			concurrency: config.concurrency
		})
		yield* Effect.logInfo(
			`    Found release notes for ${notes.size}/${remaining.length} packages`
		)

		yield* Effect.logInfo('  Grouping updates...')
		const assigned = assignToGroups({
			candidates: remaining,
			groups: config.groups
		})

		const assignedNames = new Set(
			[...assigned.values()].flat().map((u) => u.name)
		)
		const unassigned = remaining.filter((c) => !assignedNames.has(c.name))
		for (const candidate of unassigned) {
			const sanitizedName = candidate.name
				.replace(/^@/, '')
				.replaceAll('/', '-')
			assigned.set(sanitizedName, [candidate])
		}

		for (const [groupName, updates] of assigned) {
			const types = [...new Set(updates.map((u) => u.changeType))].join(', ')
			yield* Effect.logInfo(
				`    ${groupName}: ${updates.map((u) => u.name).join(', ')} (${types})`
			)
		}

		return { candidates: remaining, groups: assigned, releaseNotes: notes }
	}
)

const loadExistingOverrides = Effect.fn('Pipeline.loadExistingOverrides')(
	function* (run: DirectoryRun) {
		const fs = yield* FileSystem.FileSystem
		const { audit } = getProvider(run.location.providerId)
		const content = yield* fs
			.readFileString(`${run.dir.workDir}/${audit.overrideFile}`)
			.pipe(Effect.option)
		if (Option.isNone(content)) {
			return {}
		}
		return audit.readOverrides({ content: content.value }) ?? {}
	}
)

const findOverrideUpdates = Effect.fn('Pipeline.findOverrideUpdates')(
	function* ({
		run,
		entries
	}: {
		run: DirectoryRun
		entries: Array<CatalogEntry>
	}) {
		if (!run.config.audit.enabled) {
			return { overrideBranchUpdate: null, overrideEntries: [] }
		}

		const { audit } = getProvider(run.location.providerId)

		yield* Effect.logInfo(`  Running ${run.location.providerId} audit...`)
		const auditResult = yield* runAudit({ cwd: run.dir.workDir, audit })

		if (Option.isNone(auditResult)) {
			yield* Effect.logInfo('    Audit unavailable or failed, skipping')
			return { overrideBranchUpdate: null, overrideEntries: [] }
		}

		const catalogNames = new Set(entries.map((e) => e.name))
		const overrideEntries = computeOverrides({
			auditResult: auditResult.value,
			catalogNames,
			minimumSeverity: run.config.audit.minimumSeverity,
			existingOverrides: yield* loadExistingOverrides(run),
			audit
		})

		if (overrideEntries.length === 0) {
			yield* Effect.logInfo('    No transitive vulnerability overrides needed')
			return { overrideBranchUpdate: null, overrideEntries }
		}

		const staleCount = overrideEntries.filter(
			(e) => e.existingOverrideStale
		).length
		const newCount = overrideEntries.length - staleCount
		const parts: Array<string> = []
		if (newCount > 0) {
			parts.push(`${newCount} new`)
		}
		if (staleCount > 0) {
			parts.push(`${staleCount} stale (lockfile not re-resolved)`)
		}
		yield* Effect.logInfo(
			`    Found ${overrideEntries.length} transitive vulnerability override(s): ${parts.join(', ')}`
		)
		const overrideBranchUpdate = buildOverrideBranchUpdate({
			overrides: overrideEntries,
			branchPrefix: run.effectiveBranchPrefix,
			titleSuffix: run.titleSuffix,
			workDir: run.dir.workDir,
			providerId: run.location.providerId
		})

		return { overrideBranchUpdate, overrideEntries }
	}
)

const syncDirectoryPrs = Effect.fn('Pipeline.syncDirectoryPrs')(function* ({
	catalog,
	existingPrs
}: {
	catalog: CatalogRun
	existingPrs: Array<ExistingPr>
}) {
	const { dir, config, location, effectiveBranchPrefix } = catalog
	const provider = getProvider(location.providerId)
	const buildBranchUpdate = makeCatalogBranchBuilder(catalog)

	const overrideBranchPrefix = getOverrideBranchPrefix({
		branchPrefix: effectiveBranchPrefix
	})
	const catalogPrs = existingPrs.filter((pr) =>
		pr.headRefName.startsWith(`${effectiveBranchPrefix}/`)
	)
	const overridePrs = existingPrs.filter((pr) =>
		pr.headRefName.startsWith(`${overrideBranchPrefix}/`)
	)

	// 6b. Sync existing catalog PRs
	yield* Effect.logInfo('  Syncing existing catalog PRs...')
	const catalogSyncResult = yield* syncExistingPrs({
		existingPrs: catalogPrs,
		// Catalog branches are `${prefix}/${groupName}` by construction, so
		// one slice recovers the group and its updates. The drift check
		// closes over both instead of re-deriving them from branch strings.
		resolveSyncPlan: (pr) => {
			const groupName = pr.headRefName.slice(`${effectiveBranchPrefix}/`.length)
			const updates = catalog.groups.get(groupName)
			if (!updates || updates.length === 0) {
				return null
			}
			return {
				branchUpdate: buildBranchUpdate(groupName, updates),
				isOutdated: ({ branchFiles }) => {
					const definitionContent = branchFiles.get(location.definitionRelPath)
					if (definitionContent === null || definitionContent === undefined) {
						return true
					}
					const definitions = provider.parseDefinitions({
						content: definitionContent
					})
					const definition = definitions.find(
						(d) => d.catalogName === location.definition.catalogName
					)
					if (!definition) {
						return true
					}
					return updates.some(
						(update) =>
							definition.entries[update.name] !== buildCatalogValue({ update })
					)
				}
			}
		},
		config,
		dir
	})

	// 6c. Sync existing override PRs
	let overrideSyncResult = { closedCount: 0, rebuiltCount: 0 }
	if (overridePrs.length > 0) {
		yield* Effect.logInfo('  Syncing existing override PRs...')
		const { audit } = provider
		overrideSyncResult = yield* syncExistingPrs({
			existingPrs: overridePrs,
			resolveSyncPlan: () =>
				catalog.overrideBranchUpdate === null
					? null
					: {
							branchUpdate: catalog.overrideBranchUpdate,
							isOutdated: ({ branchFiles }) =>
								isOverrideBranchOutdated({
									branchFiles,
									audit,
									expectedOverrides: catalog.overrideEntries
								})
						},
			config,
			dir
		})
	}

	return {
		closedCount: catalogSyncResult.closedCount + overrideSyncResult.closedCount,
		rebuiltCount:
			catalogSyncResult.rebuiltCount + overrideSyncResult.rebuiltCount
	}
})

const createDirectoryPrs = Effect.fn('Pipeline.createDirectoryPrs')(function* ({
	catalog,
	existingPrs,
	closedCount
}: {
	catalog: CatalogRun
	existingPrs: Array<ExistingPr>
	closedCount: number
}) {
	const { dir, config, effectiveBranchPrefix } = catalog
	const { overrideBranchUpdate, groups } = catalog
	const buildBranchUpdate = makeCatalogBranchBuilder(catalog)

	const existingBranches = new Set(existingPrs.map((pr) => pr.headRefName))
	// openPrCount is the single budget counter: closed PRs free their slot,
	// each successful creation takes one.
	let openPrCount = existingPrs.length - closedCount

	yield* Effect.logInfo(
		`  PR limit: ${config.maxOpenPrs}, existing: ${openPrCount}, available slots: ${config.maxOpenPrs - openPrCount}`
	)

	let created = 0
	let attempted = 0

	// Override PR first (security priority)
	if (
		overrideBranchUpdate &&
		openPrCount < config.maxOpenPrs &&
		!existingBranches.has(overrideBranchUpdate.branch)
	) {
		attempted++
		const success = yield* createPr({
			branchUpdate: overrideBranchUpdate,
			config,
			dir
		})
		if (success) {
			created++
			openPrCount++
		}
	}

	// Catalog PRs. Each createPr checks out, installs, commits and
	// force-pushes its own branch in the shared working tree, so PRs are
	// created one at a time.
	for (const [groupName, updates] of groups) {
		if (openPrCount >= config.maxOpenPrs) {
			yield* Effect.logInfo(
				`  Reached PR limit (${config.maxOpenPrs}). Stopping.`
			)
			break
		}

		const branch = `${effectiveBranchPrefix}/${groupName}`
		if (existingBranches.has(branch)) {
			continue
		}

		attempted++
		const success = yield* createPr({
			branchUpdate: buildBranchUpdate(groupName, updates),
			config,
			dir
		})
		if (success) {
			created++
			openPrCount++
		}
	}

	// Counting attempts rather than a pre-computed expectation: a failed
	// creation frees its slot for a later group, but the failure itself must
	// still surface in the summary.
	const failed = attempted - created

	return { created, failed }
})

/**
 * Runs the full update pipeline for one catalog location: load config,
 * re-parse the definition, query the registry, group updates, run the
 * provider audit, then sync and create PRs. A fatal git failure (the working
 * tree could not be restored) surfaces as a GitError to the caller.
 */
export const processCatalog = Effect.fn('Pipeline.processCatalog')(function* ({
	location,
	cwd,
	configPath,
	dryRun
}: {
	location: CatalogLocation
	cwd: string
	configPath: string
	dryRun: boolean
}) {
	const dir = buildDirectoryContext({ cwd, dir: location.dir })
	const provider = getProvider(location.providerId)
	const catalogName = location.definition.catalogName

	// 1. Load config
	const config = yield* loadConfigForDirectory({ dir, configPath })

	// Named catalogs get their own branch segment; the default catalog keeps
	// the historical branch layout.
	const prefixSegments = [config.branchPrefix]
	const titleParts: Array<string> = []
	if (location.dir !== '.') {
		prefixSegments.push(location.dir)
		titleParts.push(`in /${location.dir}`)
	}
	if (catalogName !== 'default') {
		prefixSegments.push(catalogName)
		titleParts.push(`catalog ${catalogName}`)
	}
	const effectiveBranchPrefix = prefixSegments.filter(Boolean).join('/')
	const titleSuffix = titleParts.length > 0 ? ` (${titleParts.join(', ')})` : ''

	const run: DirectoryRun = {
		dir,
		config,
		location,
		titleSuffix,
		effectiveBranchPrefix
	}

	// 2. Re-read the catalog definition (discovery may have run before a fetch)
	yield* Effect.logInfo('  Parsing catalog...')
	const fs = yield* FileSystem.FileSystem
	const definitionContent = yield* fs
		.readFileString(`${dir.workDir}/${location.definitionRelPath}`)
		.pipe(Effect.option)
	const definition: ParsedCatalog | undefined = Option.isSome(definitionContent)
		? provider
				.parseDefinitions({ content: definitionContent.value })
				.find((d) => d.catalogName === catalogName)
		: undefined

	if (Option.isNone(definitionContent)) {
		yield* Effect.logWarning(
			`  Warning: could not read ${location.definitionRelPath}: file unavailable`
		)
	}
	if (!definition) {
		yield* Effect.logError(
			`  No catalog "${catalogName}" found in ${location.definitionRelPath}`
		)
		return { created: 0, failed: 0, rebuilt: 0 }
	}

	const entries = parseCatalog({ catalog: definition.entries })
	yield* Effect.logInfo(
		`    Found ${entries.length} catalog entries (${provider.id}, ${location.definitionRelPath})`
	)

	// 3–4. Query registry and find updates
	const candidates = yield* findCatalogCandidates({ entries, config })

	// 5. Group updates and fetch release notes
	const {
		candidates: eligibleCandidates,
		groups,
		releaseNotes
	} = yield* buildGroupedUpdates({ candidates, config })

	// 5b. Override pipeline
	const { overrideBranchUpdate, overrideEntries } = yield* findOverrideUpdates({
		run,
		entries
	})

	if (eligibleCandidates.length === 0 && !overrideBranchUpdate) {
		yield* Effect.logInfo('  No updates available')
		return { created: 0, failed: 0, rebuilt: 0 }
	}

	if (dryRun) {
		const parts: Array<string> = []
		if (groups.size > 0) {
			parts.push(`${groups.size} catalog PRs`)
		}
		if (overrideBranchUpdate) {
			parts.push('1 override PR')
		}
		yield* Effect.logInfo(`  [DRY RUN] Would create ${parts.join(' and ')}`)
		return { created: 0, failed: 0, rebuilt: 0 }
	}

	// Everything the PR stages share, now that the update artifacts exist.
	const catalog: CatalogRun = {
		...run,
		groups,
		releaseNotes,
		overrideBranchUpdate,
		overrideEntries
	}

	// 6–6c. Sync existing PRs
	yield* Effect.logInfo('  Checking existing PRs...')
	const existingPrs = yield* getExistingPrs({
		cwd: dir.cwd,
		branchPrefix: effectiveBranchPrefix
	})
	yield* Effect.logInfo(
		`    Found ${existingPrs.length} existing catalog-update PRs`
	)

	const { closedCount, rebuiltCount } = yield* syncDirectoryPrs({
		catalog,
		existingPrs
	})

	// 7. Create PRs
	const { created, failed } = yield* createDirectoryPrs({
		catalog,
		existingPrs,
		closedCount
	})

	return { created, failed, rebuilt: rebuiltCount }
})
