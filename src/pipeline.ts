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
import {
	queryNpmRegistry,
	queryPackageMetadata,
	queryReleaseNotes,
	filterByReleaseAge
} from './registry'
import {
	classifySemverChange,
	Semaphore,
	getOverrideBranchPrefix
} from './utils'
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

async function loadConfigForDirectory({
	dir,
	configPath
}: {
	dir: DirectoryContext
	configPath: string
}): Promise<Config> {
	console.log('  Loading config...')
	const config = await loadConfig({
		configPath: `${dir.workDir}/${configPath}`
	})
	console.log(`    Branch prefix: ${config.branchPrefix}`)
	console.log(`    Default branch: ${config.defaultBranch}`)
	console.log(`    Groups: ${config.groups.length}`)
	console.log(`    Ignore rules: ${config.ignore.length}`)
	console.log(
		`    Audit: ${config.audit.enabled ? `enabled (minimum severity: ${config.audit.minimumSeverity})` : 'disabled'}`
	)
	if (config.minReleaseAgeDays > 0) {
		console.log(`    Min release age: ${config.minReleaseAgeDays} day(s)`)
	}
	return config
}

async function findCatalogCandidates({
	entries,
	config
}: {
	entries: Array<CatalogEntry>
	config: Config
}): Promise<Array<UpdateCandidate>> {
	console.log('  Querying npm registry...')
	const semaphore = new Semaphore(config.concurrency)
	const latestVersions = await queryNpmRegistry({ entries, semaphore })
	console.log(`    Got latest versions for ${latestVersions.size} packages`)

	console.log('  Finding available updates...')
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

		if (shouldIgnore({ name: entry.name, changeType, rules: config.ignore })) {
			continue
		}

		candidates.push({ ...entry, latestVersion: latest, changeType })
	}

	console.log(`    Found ${candidates.length} packages with updates`)
	return candidates
}

async function buildGroupedUpdates({
	candidates,
	config
}: {
	candidates: Array<UpdateCandidate>
	config: Config
}): Promise<{
	candidates: Array<UpdateCandidate>
	groups: Map<string, Array<UpdateCandidate>>
	releaseNotes: Map<string, Array<VersionReleaseNote>>
}> {
	const groups = new Map<string, Array<UpdateCandidate>>()
	const releaseNotes = new Map<string, Array<VersionReleaseNote>>()
	if (candidates.length === 0) {
		return { candidates, groups, releaseNotes }
	}

	console.log('  Fetching package metadata...')
	const semaphore = new Semaphore(config.concurrency)
	const packageMetadata = await queryPackageMetadata({ candidates, semaphore })
	console.log(
		`    Found metadata for ${packageMetadata.size}/${candidates.length} packages`
	)

	// Filter by minimum release age (supply chain protection)
	let remaining = candidates
	if (config.minReleaseAgeDays > 0) {
		console.log(
			`  Filtering by minimum release age (${config.minReleaseAgeDays} day(s))...`
		)
		const beforeCount = candidates.length
		remaining = filterByReleaseAge({
			candidates,
			packageMetadata,
			minReleaseAgeDays: config.minReleaseAgeDays
		})
		const skipped = beforeCount - remaining.length
		if (skipped > 0) {
			console.log(`    Skipped ${skipped} package(s) due to release age`)
		}
	}

	console.log('  Fetching release notes...')
	const notes = await queryReleaseNotes({
		candidates: remaining,
		packageMetadata,
		semaphore
	})
	console.log(
		`    Found release notes for ${notes.size}/${remaining.length} packages`
	)

	console.log('  Grouping updates...')
	const assigned = assignToGroups({
		candidates: remaining,
		groups: config.groups
	})

	const assignedNames = new Set(
		[...assigned.values()].flat().map((u) => u.name)
	)
	const unassigned = remaining.filter((c) => !assignedNames.has(c.name))
	for (const candidate of unassigned) {
		const sanitizedName = candidate.name.replace(/^@/, '').replaceAll('/', '-')
		assigned.set(sanitizedName, [candidate])
	}

	for (const [groupName, updates] of assigned) {
		const types = [...new Set(updates.map((u) => u.changeType))].join(', ')
		console.log(
			`    ${groupName}: ${updates.map((u) => u.name).join(', ')} (${types})`
		)
	}

	return { candidates: remaining, groups: assigned, releaseNotes: notes }
}

async function loadExistingOverrides({
	dir,
	providerId
}: {
	dir: DirectoryContext
	providerId: CatalogLocation['providerId']
}): Promise<Record<string, string>> {
	const { audit } = getProvider(providerId)
	try {
		const content = await Bun.file(
			`${dir.workDir}/${audit.overrideFile}`
		).text()
		return audit.readOverrides({ content }) ?? {}
	} catch {
		return {}
	}
}

async function findOverrideUpdates({
	dir,
	config,
	providerId,
	entries,
	effectiveBranchPrefix,
	titleSuffix
}: {
	dir: DirectoryContext
	config: Config
	providerId: CatalogLocation['providerId']
	entries: Array<CatalogEntry>
	effectiveBranchPrefix: string
	titleSuffix: string
}): Promise<{
	overrideBranchUpdate: BranchUpdate | null
	overrideEntries: Array<OverrideEntry>
}> {
	if (!config.audit.enabled) {
		return { overrideBranchUpdate: null, overrideEntries: [] }
	}

	const { audit } = getProvider(providerId)

	console.log(`  Running ${providerId} audit...`)
	const auditResult = await runAudit({ cwd: dir.workDir, audit })

	if (!auditResult) {
		console.log('    Audit unavailable or failed, skipping')
		return { overrideBranchUpdate: null, overrideEntries: [] }
	}

	const catalogNames = new Set(entries.map((e) => e.name))
	const overrideEntries = computeOverrides({
		auditResult,
		catalogNames,
		minimumSeverity: config.audit.minimumSeverity,
		existingOverrides: await loadExistingOverrides({ dir, providerId }),
		audit
	})

	if (overrideEntries.length === 0) {
		console.log('    No transitive vulnerability overrides needed')
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
	console.log(
		`    Found ${overrideEntries.length} transitive vulnerability override(s): ${parts.join(', ')}`
	)
	const overrideBranchUpdate = buildOverrideBranchUpdate({
		overrides: overrideEntries,
		branchPrefix: effectiveBranchPrefix,
		titleSuffix,
		workDir: dir.workDir,
		providerId
	})

	return { overrideBranchUpdate, overrideEntries }
}

function groupNameFromBranch({
	branchName,
	branchPrefix
}: {
	branchName: string
	branchPrefix: string
}): string {
	return branchName.slice(`${branchPrefix}/`.length)
}

async function syncDirectoryPrs({
	dir,
	config,
	location,
	groups,
	releaseNotes,
	titleSuffix,
	effectiveBranchPrefix,
	overrideBranchUpdate,
	overrideEntries
}: {
	dir: DirectoryContext
	config: Config
	location: CatalogLocation
	groups: Map<string, Array<UpdateCandidate>>
	releaseNotes: Map<string, Array<VersionReleaseNote>>
	titleSuffix: string
	effectiveBranchPrefix: string
	overrideBranchUpdate: BranchUpdate | null
	overrideEntries: Array<OverrideEntry>
}): Promise<{
	existingPrs: Array<ExistingPr>
	closedCount: number
	rebuiltCount: number
}> {
	console.log('  Checking existing PRs...')
	const existingPrs = await getExistingPrs({
		cwd: dir.cwd,
		branchPrefix: effectiveBranchPrefix
	})
	console.log(`    Found ${existingPrs.length} existing catalog-update PRs`)

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
	console.log('  Syncing existing catalog PRs...')
	const catalogSyncResult = await syncExistingPrs({
		existingPrs: catalogPrs,
		resolveBranchUpdate: (branchName: string) => {
			const groupName = groupNameFromBranch({
				branchName,
				branchPrefix: effectiveBranchPrefix
			})
			const updates = groups.get(groupName)
			if (!updates || updates.length === 0) {
				return null
			}
			return buildCatalogBranchUpdate({
				groupName,
				updates,
				config,
				location,
				workDir: dir.workDir,
				titleSuffix,
				branchPrefix: effectiveBranchPrefix,
				releaseNotes
			})
		},
		isBranchOutdated: ({ branchUpdate, branchFiles }) => {
			const definitionContent = branchFiles.get(location.definitionRelPath)
			if (definitionContent === null || definitionContent === undefined) {
				return true
			}
			const groupName = groupNameFromBranch({
				branchName: branchUpdate.branch,
				branchPrefix: effectiveBranchPrefix
			})
			const updates = groups.get(groupName)
			if (!updates || updates.length === 0) {
				return true
			}
			const provider = getProvider(location.providerId)
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
		},
		config,
		dir
	})

	// 6c. Sync existing override PRs
	let overrideSyncResult = { closedCount: 0, rebuiltCount: 0 }
	if (overridePrs.length > 0) {
		console.log('  Syncing existing override PRs...')
		const { audit } = getProvider(location.providerId)
		overrideSyncResult = await syncExistingPrs({
			existingPrs: overridePrs,
			resolveBranchUpdate: (_branchName: string) => overrideBranchUpdate,
			isBranchOutdated: ({ branchFiles }) => {
				return isOverrideBranchOutdated({
					branchFiles,
					audit,
					expectedOverrides: overrideEntries
				})
			},
			config,
			dir
		})
	}

	return {
		existingPrs,
		closedCount: catalogSyncResult.closedCount + overrideSyncResult.closedCount,
		rebuiltCount:
			catalogSyncResult.rebuiltCount + overrideSyncResult.rebuiltCount
	}
}

async function createDirectoryPrs({
	dir,
	config,
	location,
	existingPrs,
	closedCount,
	groups,
	releaseNotes,
	titleSuffix,
	effectiveBranchPrefix,
	overrideBranchUpdate
}: {
	dir: DirectoryContext
	config: Config
	location: CatalogLocation
	existingPrs: Array<ExistingPr>
	closedCount: number
	groups: Map<string, Array<UpdateCandidate>>
	releaseNotes: Map<string, Array<VersionReleaseNote>>
	titleSuffix: string
	effectiveBranchPrefix: string
	overrideBranchUpdate: BranchUpdate | null
}): Promise<{ created: number; failed: number }> {
	const existingBranches = new Set(existingPrs.map((pr) => pr.headRefName))
	const adjustedExistingCount = existingPrs.length - closedCount
	let availableSlots = config.maxOpenPrs - adjustedExistingCount

	console.log(
		`  PR limit: ${config.maxOpenPrs}, existing: ${adjustedExistingCount}, available slots: ${availableSlots}`
	)

	let created = 0
	let openPrCount = adjustedExistingCount

	// Override PR first (security priority)
	if (
		overrideBranchUpdate &&
		availableSlots > 0 &&
		!existingBranches.has(overrideBranchUpdate.branch)
	) {
		const success = await createPr({
			branchUpdate: overrideBranchUpdate,
			config,
			dir
		})
		if (success) {
			created++
			openPrCount++
			availableSlots--
		}
	}

	// Catalog PRs
	const skippedGroups = [...groups.keys()].filter((name) =>
		existingBranches.has(`${effectiveBranchPrefix}/${name}`)
	)
	const eligibleGroups = groups.size - skippedGroups.length
	const prsToCreate = Math.min(eligibleGroups, availableSlots)

	// Each createPr checks out, installs, commits and force-pushes its own
	// branch in the shared working tree, so PRs are created one at a time.
	/* oxlint-disable no-await-in-loop */
	for (const [groupName, updates] of groups) {
		if (openPrCount >= config.maxOpenPrs) {
			console.log(`  Reached PR limit (${config.maxOpenPrs}). Stopping.`)
			break
		}

		const branch = `${effectiveBranchPrefix}/${groupName}`
		if (existingBranches.has(branch)) {
			continue
		}

		const branchUpdate = buildCatalogBranchUpdate({
			groupName,
			updates,
			config,
			location,
			workDir: dir.workDir,
			titleSuffix,
			branchPrefix: effectiveBranchPrefix,
			releaseNotes
		})
		const success = await createPr({ branchUpdate, config, dir })
		if (success) {
			created++
			openPrCount++
		}
	}
	/* oxlint-enable no-await-in-loop */

	const totalExpected =
		prsToCreate +
		(overrideBranchUpdate && !existingBranches.has(overrideBranchUpdate.branch)
			? 1
			: 0)
	const failed = totalExpected - created

	return { created, failed }
}

/**
 * Runs the full update pipeline for one catalog location: load config,
 * re-parse the definition, query the registry, group updates, run the
 * provider audit, then sync and create PRs.
 */
export async function processCatalog({
	location,
	cwd,
	configPath,
	dryRun
}: {
	location: CatalogLocation
	cwd: string
	configPath: string
	dryRun: boolean
}): Promise<{ created: number; failed: number; rebuilt: number }> {
	const dir = buildDirectoryContext({ cwd, dir: location.dir })
	const provider = getProvider(location.providerId)
	const catalogName = location.definition.catalogName

	// 1. Load config
	const config = await loadConfigForDirectory({ dir, configPath })

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

	// 2. Re-read the catalog definition (discovery may have run before a fetch)
	console.log('  Parsing catalog...')
	let definition: ParsedCatalog | undefined
	try {
		const content = await Bun.file(
			`${dir.workDir}/${location.definitionRelPath}`
		).text()
		definition = provider
			.parseDefinitions({ content })
			.find((d) => d.catalogName === catalogName)
	} catch (error: unknown) {
		console.warn(
			`  Warning: could not read ${location.definitionRelPath}: ${String(error)}`
		)
	}

	if (!definition) {
		console.error(
			`  No catalog "${catalogName}" found in ${location.definitionRelPath}`
		)
		return { created: 0, failed: 0, rebuilt: 0 }
	}

	const entries = parseCatalog({ catalog: definition.entries })
	console.log(
		`    Found ${entries.length} catalog entries (${provider.id}, ${location.definitionRelPath})`
	)

	// 3–4. Query registry and find updates
	const candidates = await findCatalogCandidates({ entries, config })

	// 5. Group updates and fetch release notes
	const {
		candidates: eligibleCandidates,
		groups,
		releaseNotes
	} = await buildGroupedUpdates({ candidates, config })

	// 5b. Override pipeline
	const { overrideBranchUpdate, overrideEntries } = await findOverrideUpdates({
		dir,
		config,
		providerId: location.providerId,
		entries,
		effectiveBranchPrefix,
		titleSuffix
	})

	if (eligibleCandidates.length === 0 && !overrideBranchUpdate) {
		console.log('  No updates available')
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
		console.log(`  [DRY RUN] Would create ${parts.join(' and ')}`)
		return { created: 0, failed: 0, rebuilt: 0 }
	}

	// 6–6c. Sync existing PRs
	const { existingPrs, closedCount, rebuiltCount } = await syncDirectoryPrs({
		dir,
		config,
		location,
		groups,
		releaseNotes,
		titleSuffix,
		effectiveBranchPrefix,
		overrideBranchUpdate,
		overrideEntries
	})

	// 7. Create PRs
	const { created, failed } = await createDirectoryPrs({
		dir,
		config,
		location,
		existingPrs,
		closedCount,
		groups,
		releaseNotes,
		titleSuffix,
		effectiveBranchPrefix,
		overrideBranchUpdate
	})

	return { created, failed, rebuilt: rebuiltCount }
}
