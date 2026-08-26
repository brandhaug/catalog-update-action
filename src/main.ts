#!/usr/bin/env bun
import { version as packageVersion } from '../package.json'
import { loadConfig } from './config'
import { parseCatalog } from './catalog'
import { discoverCatalogDirectories } from './discover'
import {
	queryNpmRegistry,
	queryPackageMetadata,
	queryReleaseNotes,
	filterByReleaseAge
} from './registry'
import { shouldIgnore, assignToGroups } from './groups'
import {
	exec,
	getExistingPrs,
	syncExistingPrs,
	createPr,
	buildCatalogBranchUpdate,
	buildCatalogValue
} from './git'
import {
	runAudit,
	computeOverrides,
	buildOverrideBranchUpdate,
	isOverrideBranchOutdated
} from './audit'
import {
	classifySemverChange,
	Semaphore,
	getOverrideBranchPrefix
} from './utils'
import { readStringRecord, type PackageJson } from './schemas'
import {
	type BranchUpdate,
	type CatalogEntry,
	type Config,
	type DirectoryContext,
	type ExistingPr,
	type OverrideEntry,
	type UpdateCandidate,
	type VersionReleaseNote
} from './types'

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const HELP_TEXT = `
catalog-update — Automated dependency updates for Bun catalog: protocol

Usage:
  catalog-update [options]
  bunx catalog-update-action [options]

Options:
  -h, --help            Show this help message and exit
  -v, --version         Show version and exit
  -d, --dry-run         Show what would be updated without creating PRs
  -c, --config <path>   Path to config file (default: .catalog-updaterc.json)
  -e, --exclude <dirs>  Comma-separated directories to exclude from discovery

Examples:
  # Preview updates without creating PRs
  catalog-update --dry-run

  # Use a custom config file
  catalog-update --config custom-config.json

  # Exclude specific directories
  catalog-update --exclude "apps/legacy,packages/deprecated-*"

  # GitHub Action usage (in .github/workflows/*.yml)
  - uses: brandhaug/catalog-update-action@v1
`.trim()

function takeValue(args: string[], index: number, option: string): string {
	const value = args[index + 1]
	if (value === undefined) {
		console.error(`Missing value for ${option}`)
		process.exit(1)
	}
	return value
}

function parseArgs() {
	const args = process.argv.slice(2)
	let configPath = '.catalog-updaterc.json'
	let dryRun = false
	let excludeRaw = ''

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === undefined) break

		switch (arg) {
			case '--help':
			case '-h': {
				console.log(HELP_TEXT)
				process.exit(0)
				break
			}
			case '--version':
			case '-v': {
				console.log(packageVersion)
				process.exit(0)
				break
			}
			case '--dry-run':
			case '-d': {
				dryRun = true
				break
			}
			case '--config':
			case '-c': {
				configPath = takeValue(args, i, arg)
				i++
				break
			}
			case '--exclude':
			case '-e': {
				excludeRaw = takeValue(args, i, arg)
				i++
				break
			}
			default: {
				if (arg.startsWith('-')) {
					console.error(`Unknown option: ${arg}`)
					console.error('Run with --help for usage information.')
					process.exit(1)
				}
				break
			}
		}
	}

	// Prefer environment variable (safe from shell injection in GitHub Actions),
	// fall back to CLI arg for local usage
	const rawExclude = process.env.CATALOG_UPDATE_EXCLUDE ?? excludeRaw
	const excludeDirectories = rawExclude
		? rawExclude
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: []

	return { dryRun, configPath, excludeDirectories }
}

// ---------------------------------------------------------------------------
// Per-directory pipeline stages
// ---------------------------------------------------------------------------

function buildDirectoryContext({
	cwd,
	workingDirectory
}: {
	cwd: string
	workingDirectory: string
}): DirectoryContext {
	const isRoot = workingDirectory === '.'
	const workDir = isRoot ? cwd : `${cwd}/${workingDirectory}`
	return {
		cwd,
		workDir,
		packageJsonPath: `${workDir}/package.json`,
		packageJsonRelPath: isRoot
			? 'package.json'
			: `${workingDirectory}/package.json`
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
	console.log(`    Package manager: ${config.packageManager}`)
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
	entries: CatalogEntry[]
	config: Config
}): Promise<UpdateCandidate[]> {
	console.log('  Querying npm registry...')
	const semaphore = new Semaphore(config.concurrency)
	const latestVersions = await queryNpmRegistry({ entries, semaphore })
	console.log(`    Got latest versions for ${latestVersions.size} packages`)

	console.log('  Finding available updates...')
	const candidates: UpdateCandidate[] = []

	for (const entry of entries) {
		const latest = latestVersions.get(entry.name)
		if (!latest) continue

		const changeType = classifySemverChange({
			from: entry.currentVersion,
			to: latest
		})
		if (changeType === null) continue

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
	candidates: UpdateCandidate[]
	config: Config
}): Promise<{
	candidates: UpdateCandidate[]
	groups: Map<string, UpdateCandidate[]>
	releaseNotes: Map<string, VersionReleaseNote[]>
}> {
	const groups = new Map<string, UpdateCandidate[]>()
	const releaseNotes = new Map<string, VersionReleaseNote[]>()
	if (candidates.length === 0) return { candidates, groups, releaseNotes }

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

async function findOverrideUpdates({
	dir,
	config,
	entries,
	packageJson,
	effectiveBranchPrefix,
	titleSuffix
}: {
	dir: DirectoryContext
	config: Config
	entries: CatalogEntry[]
	packageJson: PackageJson
	effectiveBranchPrefix: string
	titleSuffix: string
}): Promise<{
	overrideBranchUpdate: BranchUpdate | null
	overrideEntries: OverrideEntry[]
}> {
	if (!config.audit.enabled) {
		return { overrideBranchUpdate: null, overrideEntries: [] }
	}

	console.log('  Running bun audit...')
	const auditResult = await runAudit({ cwd: dir.workDir })

	if (!auditResult) {
		console.log('    bun audit unavailable or failed, skipping')
		return { overrideBranchUpdate: null, overrideEntries: [] }
	}

	const catalogNames = new Set(entries.map((e) => e.name))
	const existingOverrides = readStringRecord(packageJson.overrides) ?? {}
	const overrideEntries = computeOverrides({
		auditResult,
		catalogNames,
		minimumSeverity: config.audit.minimumSeverity,
		existingOverrides
	})

	if (overrideEntries.length === 0) {
		console.log('    No transitive vulnerability overrides needed')
		return { overrideBranchUpdate: null, overrideEntries }
	}

	const staleCount = overrideEntries.filter(
		(e) => e.existingOverrideStale
	).length
	const newCount = overrideEntries.length - staleCount
	const parts: string[] = []
	if (newCount > 0) parts.push(`${newCount} new`)
	if (staleCount > 0) {
		parts.push(`${staleCount} stale (lockfile not re-resolved)`)
	}
	console.log(
		`    Found ${overrideEntries.length} transitive vulnerability override(s): ${parts.join(', ')}`
	)
	const overrideBranchUpdate = buildOverrideBranchUpdate({
		overrides: overrideEntries,
		branchPrefix: effectiveBranchPrefix,
		titleSuffix
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
	groups,
	releaseNotes,
	titleSuffix,
	effectiveBranchPrefix,
	overrideBranchUpdate,
	overrideEntries
}: {
	dir: DirectoryContext
	config: Config
	groups: Map<string, UpdateCandidate[]>
	releaseNotes: Map<string, VersionReleaseNote[]>
	titleSuffix: string
	effectiveBranchPrefix: string
	overrideBranchUpdate: BranchUpdate | null
	overrideEntries: OverrideEntry[]
}): Promise<{
	existingPrs: ExistingPr[]
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
			if (!updates || updates.length === 0) return null
			return buildCatalogBranchUpdate({
				groupName,
				updates,
				config,
				titleSuffix,
				branchPrefix: effectiveBranchPrefix,
				releaseNotes
			})
		},
		isBranchContentOutdated: (branchPkg: PackageJson, branchName: string) => {
			const groupName = groupNameFromBranch({
				branchName,
				branchPrefix: effectiveBranchPrefix
			})
			const updates = groups.get(groupName)
			if (!updates) return true
			const branchCatalog = readStringRecord(branchPkg.catalog)
			if (!branchCatalog) return true
			for (const update of updates) {
				const expected = buildCatalogValue({ update })
				if (branchCatalog[update.name] !== expected) return true
			}
			return false
		},
		config,
		dir
	})

	// 6c. Sync existing override PRs
	let overrideSyncResult = { closedCount: 0, rebuiltCount: 0 }
	if (overridePrs.length > 0) {
		console.log('  Syncing existing override PRs...')
		overrideSyncResult = await syncExistingPrs({
			existingPrs: overridePrs,
			resolveBranchUpdate: (_branchName: string) => overrideBranchUpdate,
			isBranchContentOutdated: (branchPkg: PackageJson) => {
				return isOverrideBranchOutdated({
					branchPackageJson: branchPkg,
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
	existingPrs: ExistingPr[]
	closedCount: number
	groups: Map<string, UpdateCandidate[]>
	releaseNotes: Map<string, VersionReleaseNote[]>
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
		if (existingBranches.has(branch)) continue

		const branchUpdate = buildCatalogBranchUpdate({
			groupName,
			updates,
			config,
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

async function processDirectory({
	workingDirectory,
	cwd,
	configPath,
	dryRun
}: {
	workingDirectory: string
	cwd: string
	configPath: string
	dryRun: boolean
}): Promise<{ created: number; failed: number; rebuilt: number }> {
	const dir = buildDirectoryContext({ cwd, workingDirectory })
	const titleSuffix = workingDirectory === '.' ? '' : ` in /${workingDirectory}`

	// 1. Load config
	const config = await loadConfigForDirectory({ dir, configPath })

	// 2. Parse catalog
	console.log('  Parsing catalog...')
	const packageJson: PackageJson = await Bun.file(dir.packageJsonPath).json()
	const catalog = readStringRecord(packageJson.catalog)

	if (!catalog) {
		console.error('  No catalog found in package.json')
		return { created: 0, failed: 0, rebuilt: 0 }
	}

	const entries = parseCatalog({ catalog })
	console.log(`    Found ${entries.length} catalog entries`)

	// 3–4. Query registry and find updates
	const candidates = await findCatalogCandidates({ entries, config })

	// 5. Group updates and fetch release notes
	const {
		candidates: eligibleCandidates,
		groups,
		releaseNotes
	} = await buildGroupedUpdates({ candidates, config })

	// 5b. Override pipeline
	const effectiveBranchPrefix =
		workingDirectory === '.'
			? config.branchPrefix
			: `${config.branchPrefix}/${workingDirectory}`
	const { overrideBranchUpdate, overrideEntries } = await findOverrideUpdates({
		dir,
		config,
		entries,
		packageJson,
		effectiveBranchPrefix,
		titleSuffix
	})

	if (eligibleCandidates.length === 0 && !overrideBranchUpdate) {
		console.log('  No updates available')
		return { created: 0, failed: 0, rebuilt: 0 }
	}

	if (dryRun) {
		const parts: string[] = []
		if (groups.size > 0) parts.push(`${groups.size} catalog PRs`)
		if (overrideBranchUpdate) parts.push('1 override PR')
		console.log(`  [DRY RUN] Would create ${parts.join(' and ')}`)
		return { created: 0, failed: 0, rebuilt: 0 }
	}

	// 6–6c. Sync existing PRs
	const { existingPrs, closedCount, rebuiltCount } = await syncDirectoryPrs({
		dir,
		config,
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const { dryRun, configPath, excludeDirectories } = parseArgs()
	const cwd = process.cwd()

	console.log('Catalog Dependency Updater')
	console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`)
	console.log(`Config: ${configPath}`)
	if (excludeDirectories.length > 0) {
		console.log(`Exclude: ${excludeDirectories.join(', ')}`)
	}
	console.log('')

	// 0. Fetch latest remote refs and remember the starting branch for recovery
	console.log('Fetching latest remote refs...')
	const fetchResult = await exec({ command: ['git', 'fetch', 'origin'], cwd })
	if (fetchResult.exitCode !== 0) {
		console.error('Failed to fetch from origin')
		process.exit(1)
	}
	const startBranchResult = await exec({
		command: ['git', 'branch', '--show-current'],
		cwd
	})
	const startBranch = startBranchResult.stdout.trim()

	// 1. Discover catalog directories
	console.log('\nDiscovering catalog directories...')
	const directories = await discoverCatalogDirectories({
		cwd,
		excludePatterns: excludeDirectories
	})

	if (directories.length === 0) {
		console.log('No directories with a catalog found.')
		return
	}

	console.log(
		`Found ${directories.length} catalog ${directories.length === 1 ? 'directory' : 'directories'}: ${directories.map((d) => (d === '.' ? '.' : `/${d}`)).join(', ')}`
	)

	// 2. Process each directory
	let totalCreated = 0
	let totalFailed = 0
	let totalRebuilt = 0

	// Directories are processed one at a time on purpose: each one checks out
	// branches and runs installs in the shared working tree, so running them
	// concurrently would race the same files.
	/* oxlint-disable no-await-in-loop */
	for (const dir of directories) {
		const label = dir === '.' ? '(root)' : `/${dir}`
		console.log(`\n${'='.repeat(60)}`)
		console.log(`Processing ${label}`)
		console.log('='.repeat(60))

		try {
			const result = await processDirectory({
				workingDirectory: dir,
				cwd,
				configPath,
				dryRun
			})
			totalCreated += result.created
			totalFailed += result.failed
			totalRebuilt += result.rebuilt
		} catch (error: unknown) {
			console.error(`  Failed to process ${label}: ${String(error)}`)
			totalFailed++
			// Best-effort recovery: return to a clean default branch state so
			// subsequent directories aren't processed from a stale branch.
			await exec({ command: ['git', 'checkout', '--', '.'], cwd })
			await exec({ command: ['git', 'checkout', startBranch], cwd })
		}
	}
	/* oxlint-enable no-await-in-loop */

	// Restore the branch the run started on, so CLI users are not left parked
	// on the default branch after a successful run. In CI the checkout may be
	// detached (no current branch); only restore when there is one to return to.
	if (startBranch) {
		await exec({ command: ['git', 'checkout', startBranch], cwd })
	}

	// 3. Summary
	if (!dryRun) {
		const total = totalCreated + totalFailed
		console.log(`\n${'='.repeat(60)}`)
		console.log(
			`Summary: Created ${totalCreated}/${total} PRs, rebuilt ${totalRebuilt} existing PRs across ${directories.length} ${directories.length === 1 ? 'directory' : 'directories'}.`
		)
	}

	if (totalFailed > 0) {
		console.error(`\n${totalFailed} PR(s) failed to create.`)
		process.exit(1)
	}
}

try {
	await main()
} catch (error: unknown) {
	console.error('Fatal error:', error)
	process.exit(1)
}
