import { DateTime, Effect, FileSystem, Option } from 'effect'

import { buildCatalogPlans, type PreparedCatalog } from './catalog-plans'
import { type CatalogScope } from './scopes'
import { parseCatalog } from './catalog'
import {
	runAudit,
	computeOverrides,
	buildOverrideBranchUpdate,
	isOverrideBranchOutdated
} from './audit'
import { getExistingPrs, syncExistingPrs, createPr } from './git'
import { getProvider, type ParsedCatalog } from './providers'
import { shouldIgnore, assignToGroups } from './groups'
import { Registry } from './registry'
import { filterByReleaseAge } from './release-age'
import {
	classifySemverChange,
	getOverrideBranchPrefix,
	resolveRepoPath
} from './utils'
import {
	type CatalogEntry,
	type CatalogLocation,
	type Config,
	type DirectoryContext,
	type PrSyncPlan,
	type ExistingPr,
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
		config,
		blockedNames
	}: {
		candidates: Array<UpdateCandidate>
		config: Config
		blockedNames: ReadonlySet<string>
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
		for (const [groupName, updates] of assigned) {
			if (updates.some((update) => blockedNames.has(update.name))) {
				yield* Effect.logWarning(
					`    Skipping ${groupName}: one or more grouped updates are blocked`
				)
				assigned.delete(groupName)
			}
		}

		const assignedNames = new Set(
			[...assigned.values()].flat().map((u) => u.name)
		)
		const unassigned = remaining.filter(
			(c) => !assignedNames.has(c.name) && !blockedNames.has(c.name)
		)
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

		const eligibleCandidates = [...assigned.values()].flat()
		return {
			candidates: eligibleCandidates,
			groups: assigned,
			releaseNotes: notes
		}
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

const prepareCatalog = Effect.fn('Pipeline.prepareCatalog')(function* ({
	location,
	config,
	cwd
}: {
	location: CatalogLocation
	config: Config
	cwd: string
}) {
	const provider = getProvider(location.providerId)
	const fs = yield* FileSystem.FileSystem
	const content = yield* fs
		.readFileString(
			resolveRepoPath({ cwd, relPath: location.definitionRelPath })
		)
		.pipe(Effect.option)
	const definition: ParsedCatalog | undefined = Option.isSome(content)
		? provider
				.parseDefinitions({ content: content.value })
				.find((d) => d.catalogName === location.definition.catalogName)
		: undefined
	if (!definition || Option.isNone(content)) {
		return null
	}
	const currentLocation = { ...location, definition }
	const entries = parseCatalog({ catalog: definition.entries })
	const candidates = yield* findCatalogCandidates({ entries, config })
	const blockedNames = new Set<string>()
	for (const update of candidates) {
		const reason = provider.getUpdateBlockReason?.({
			content: content.value,
			update
		})
		if (reason) {
			yield* Effect.logWarning(`    Skipping ${update.name}: ${reason}`)
			blockedNames.add(update.name)
		}
	}
	const { groups, releaseNotes } = yield* buildGroupedUpdates({
		candidates,
		config,
		blockedNames
	})
	return { location: currentLocation, groups, releaseNotes }
})

/** A shared pin cannot advance in just one of the catalogs using it. */
function omitPartialUpdates(catalogs: Array<PreparedCatalog>): number {
	let removed = 0
	let changed = true
	while (changed) {
		changed = false
		const outcomes = new Map<string, Set<string | undefined>>()
		for (const catalog of catalogs) {
			const updates = new Map(
				[...catalog.groups.values()]
					.flat()
					.map((update) => [update.name, update.latestVersion])
			)
			for (const [name, value] of Object.entries(
				catalog.location.definition.entries
			)) {
				const key = `${name}\0${value}`
				const versions = outcomes.get(key) ?? new Set()
				versions.add(updates.get(name))
				outcomes.set(key, versions)
			}
		}
		const blockedGroups = new Set<string>()
		for (const catalog of catalogs) {
			for (const [group, updates] of catalog.groups) {
				if (
					updates.some(
						(update) =>
							(outcomes.get(
								`${update.name}\0${catalog.location.definition.entries[update.name]}`
							)?.size ?? 0) > 1
					)
				) {
					blockedGroups.add(group)
				}
			}
		}
		for (const catalog of catalogs) {
			for (const group of blockedGroups) {
				if (catalog.groups.delete(group)) {
					removed++
					changed = true
				}
			}
		}
	}
	return removed
}

export const processCatalogScope = Effect.fn('Pipeline.processCatalogScope')(
	function* ({
		scope,
		cwd,
		dryRun
	}: {
		scope: CatalogScope
		cwd: string
		dryRun: boolean
	}) {
		const { config } = scope
		const catalogs: Array<PreparedCatalog> = []
		for (const location of scope.locations) {
			const prepared = yield* prepareCatalog({ location, config, cwd })
			if (!prepared) {
				yield* Effect.logError(
					`Cannot read catalog ${location.definitionRelPath}; skipping the entire shared scope`
				)
				return { created: 0, failed: 1, rebuilt: 0 }
			}
			catalogs.push(prepared)
		}
		const omitted = omitPartialUpdates(catalogs)
		if (omitted > 0) {
			yield* Effect.logWarning(
				`Skipped ${omitted} groups because shared catalog pins could not be updated together`
			)
		}
		const catalogPlans = buildCatalogPlans({
			catalogs,
			config,
			cwd,
			branchPrefix: scope.branchPrefix
		})
		const plans = new Map<string, PrSyncPlan>()
		const auditPrefixes = new Set<string>()
		for (const { location } of catalogs) {
			const prefix = [
				config.branchPrefix,
				location.dir === '.' ? '' : location.dir,
				location.definition.catalogName === 'default'
					? ''
					: location.definition.catalogName
			]
				.filter(Boolean)
				.join('/')
			const dir = {
				cwd,
				workDir: resolveRepoPath({ cwd, relPath: location.dir })
			}
			const run = {
				dir,
				config,
				location,
				effectiveBranchPrefix: prefix,
				titleSuffix: location.dir === '.' ? '' : ` (in /${location.dir})`
			}
			const { overrideBranchUpdate, overrideEntries } =
				yield* findOverrideUpdates({
					run,
					entries: parseCatalog({ catalog: location.definition.entries })
				})
			auditPrefixes.add(prefix)
			if (overrideBranchUpdate) {
				const { audit } = getProvider(location.providerId)
				const overrideRelPath =
					location.dir === '.'
						? audit.overrideFile
						: `${location.dir}/${audit.overrideFile}`
				plans.set(overrideBranchUpdate.branch, {
					branchUpdate: {
						...overrideBranchUpdate,
						affectedFiles: [overrideRelPath]
					},
					isOutdated: ({ branchFiles }) =>
						isOverrideBranchOutdated({
							branchFiles: new Map([
								[audit.overrideFile, branchFiles.get(overrideRelPath) ?? null]
							]),
							audit,
							expectedOverrides: overrideEntries
						})
				})
			}
		}
		for (const [branch, plan] of catalogPlans) {
			plans.set(branch, plan)
		}
		if (dryRun) {
			yield* Effect.logInfo(
				`  [DRY RUN] Would create ${plans.size} PRs across ${catalogs.length} catalogs`
			)
			return { created: 0, failed: 0, rebuilt: 0 }
		}
		if (plans.size === 0) {
			yield* Effect.logInfo('  No updates available')
			return { created: 0, failed: 0, rebuilt: 0 }
		}
		const existing = new Map<number, ExistingPr>()
		const catalogPrs = yield* getExistingPrs({
			cwd,
			branchPrefix: scope.branchPrefix
		})
		for (const pr of catalogPrs) {
			if (pr.headRefName.startsWith(`${scope.branchPrefix}/`)) {
				existing.set(pr.number, pr)
			}
		}
		for (const prefix of auditPrefixes) {
			const prs =
				prefix === scope.branchPrefix
					? catalogPrs
					: yield* getExistingPrs({ cwd, branchPrefix: prefix })
			const overridePrefix = getOverrideBranchPrefix({ branchPrefix: prefix })
			for (const pr of prs) {
				if (
					prefix !== scope.branchPrefix &&
					pr.headRefName.startsWith(`${prefix}/`)
				) {
					const canonicalBranch = `${scope.branchPrefix}/${pr.headRefName.slice(prefix.length + 1)}`
					const plan = plans.get(canonicalBranch)
					const canonicalExists = [...existing.values()].some(
						(candidate) => candidate.headRefName === canonicalBranch
					)
					if (plan && !canonicalExists) {
						plans.delete(canonicalBranch)
						plans.set(pr.headRefName, {
							...plan,
							branchUpdate: { ...plan.branchUpdate, branch: pr.headRefName }
						})
						existing.set(pr.number, pr)
					}
				}
				if (pr.headRefName.startsWith(`${overridePrefix}/`)) {
					existing.set(pr.number, pr)
				}
			}
		}
		const dir = { cwd, workDir: resolveRepoPath({ cwd, relPath: scope.dir }) }
		const existingPrs = [...existing.values()]
		const sync = yield* syncExistingPrs({
			existingPrs,
			resolveSyncPlan: (pr) => plans.get(pr.headRefName) ?? null,
			config,
			dir
		})
		const existingBranches = new Set(existingPrs.map((pr) => pr.headRefName))
		let open = existingPrs.length - sync.closedCount
		let created = 0
		let failed = 0
		for (const [branch, plan] of plans) {
			if (open >= config.maxOpenPrs) {
				break
			}
			if (existingBranches.has(branch)) {
				continue
			}
			const success = yield* createPr({
				branchUpdate: plan.branchUpdate,
				config,
				dir
			})
			if (success) {
				created++
				open++
			} else {
				failed++
			}
		}
		return { created, failed, rebuilt: sync.rebuiltCount }
	}
)
