#!/usr/bin/env bun
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
import type {
	BranchUpdate,
	DirectoryContext,
	OverrideEntry,
	UpdateCandidate,
	VersionReleaseNote
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

function parseArgs(): {
	dryRun: boolean
	configPath: string
	excludeDirectories: string[]
} {
	const args = process.argv.slice(2)
	let configPath = '.catalog-updaterc.json'
	let dryRun = false
	let excludeRaw = ''

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!
		if (arg === '--help' || arg === '-h') {
			console.log(HELP_TEXT)
			process.exit(0)
		} else if (arg === '--version' || arg === '-v') {
			const pkg = require('../package.json')
			console.log(pkg.version)
			process.exit(0)
		} else if (arg === '--dry-run' || arg === '-d') {
			dryRun = true
		} else if (
			(arg === '--config' || arg === '-c') &&
			args[i + 1] !== undefined
		) {
			configPath = args[i + 1] as string
			i++
		} else if (
			(arg === '--exclude' || arg === '-e') &&
			args[i + 1] !== undefined
		) {
			excludeRaw = args[i + 1] as string
			i++
		} else if (arg.startsWith('-')) {
			console.error(`Unknown option: ${arg}`)
			console.error('Run with --help for usage information.')
			process.exit(1)
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
// Per-directory pipeline
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

	// 2. Parse catalog
	console.log('  Parsing catalog...')
	const packageJson = await Bun.file(dir.packageJsonPath).json()
	const catalog = packageJson.catalog as Record<string, string> | undefined

	if (!catalog) {
		console.error('  No catalog found in package.json')
		return { created: 0, failed: 0, rebuilt: 0 }
	}

	const entries = parseCatalog({ catalog })
	console.log(`    Found ${entries.length} catalog entries`)

	// 3. Query npm registry
	console.log('  Querying npm registry...')
	const semaphore = new Semaphore(config.concurrency)
	const latestVersions = await queryNpmRegistry({ entries, semaphore })
	console.log(`    Got latest versions for ${latestVersions.size} packages`)

	// 4. Find updates
	console.log('  Finding available updates...')
	let candidates: UpdateCandidate[] = []

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

	// 5. Catalog pipeline: metadata, release notes, grouping
	let groups = new Map<string, UpdateCandidate[]>()
	let releaseNotes = new Map<string, VersionReleaseNote[]>()

	if (candidates.length > 0) {
		console.log('  Fetching package metadata...')
		const packageMetadata = await queryPackageMetadata({
			candidates,
			semaphore
		})
		console.log(
			`    Found metadata for ${packageMetadata.size}/${candidates.length} packages`
		)

		// Filter by minimum release age (supply chain protection)
		if (config.minReleaseAgeDays > 0) {
			console.log(
				`  Filtering by minimum release age (${config.minReleaseAgeDays} day(s))...`
			)
			const beforeCount = candidates.length
			candidates = filterByReleaseAge({
				candidates,
				packageMetadata,
				minReleaseAgeDays: config.minReleaseAgeDays
			})
			const skipped = beforeCount - candidates.length
			if (skipped > 0) {
				console.log(`    Skipped ${skipped} package(s) due to release age`)
			}
		}

		console.log('  Fetching release notes...')
		releaseNotes = await queryReleaseNotes({
			candidates,
			packageMetadata,
			semaphore
		})
		console.log(
			`    Found release notes for ${releaseNotes.size}/${candidates.length} packages`
		)

		console.log('  Grouping updates...')
		groups = assignToGroups({ candidates, groups: config.groups })

		const assignedNames = new Set(
			[...groups.values()].flat().map((u) => u.name)
		)
		const unassigned = candidates.filter((c) => !assignedNames.has(c.name))
		for (const candidate of unassigned) {
			const sanitizedName = candidate.name
				.replace(/^@/, '')
				.replaceAll('/', '-')
			groups.set(sanitizedName, [candidate])
		}

		for (const [groupName, updates] of groups) {
			const types = [...new Set(updates.map((u) => u.changeType))].join(', ')
			console.log(
				`    ${groupName}: ${updates.map((u) => u.name).join(', ')} (${types})`
			)
		}
	}

	// 5b. Override pipeline
	let overrideBranchUpdate: BranchUpdate | null = null
	let overrideEntries: OverrideEntry[] = []
	const effectiveBranchPrefix =
		workingDirectory === '.'
			? config.branchPrefix
			: `${config.branchPrefix}/${workingDirectory}`
	const overrideBranchPrefix = getOverrideBranchPrefix({
		branchPrefix: effectiveBranchPrefix
	})

	if (config.audit.enabled) {
		console.log('  Running bun audit...')
		const auditResult = await runAudit({ cwd: dir.workDir })

		if (auditResult) {
			const catalogNames = new Set(entries.map((e) => e.name))
			const existingOverrides =
				(packageJson.overrides as Record<string, string> | undefined) ?? {}

			overrideEntries = computeOverrides({
				auditResult,
				catalogNames,
				minimumSeverity: config.audit.minimumSeverity,
				existingOverrides
			})

			if (overrideEntries.length > 0) {
				const staleCount = overrideEntries.filter(
					(e) => e.existingOverrideStale
				).length
				const newCount = overrideEntries.length - staleCount
				const parts: string[] = []
				if (newCount > 0) parts.push(`${newCount} new`)
				if (staleCount > 0)
					parts.push(`${staleCount} stale (lockfile not re-resolved)`)
				console.log(
					`    Found ${overrideEntries.length} transitive vulnerability override(s): ${parts.join(', ')}`
				)
				overrideBranchUpdate = buildOverrideBranchUpdate({
					overrides: overrideEntries,
					branchPrefix: effectiveBranchPrefix,
					titleSuffix
				})
			} else {
				console.log('    No transitive vulnerability overrides needed')
			}
		} else {
			console.log('    bun audit unavailable or failed, skipping')
		}
	}

	if (candidates.length === 0 && !overrideBranchUpdate) {
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

	// 6. Check existing PRs
	console.log('  Checking existing PRs...')
	const existingPrs = await getExistingPrs({
		cwd: dir.cwd,
		branchPrefix: effectiveBranchPrefix
	})
	console.log(`    Found ${existingPrs.length} existing catalog-update PRs`)

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
			const groupName = branchName.slice(`${effectiveBranchPrefix}/`.length)
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
		isBranchContentOutdated: (
			branchPkg: Record<string, unknown>,
			branchName: string
		) => {
			const groupName = branchName.slice(`${effectiveBranchPrefix}/`.length)
			const updates = groups.get(groupName)
			if (!updates) return true
			const branchCatalog = branchPkg.catalog as
				| Record<string, string>
				| undefined
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
			isBranchContentOutdated: (branchPkg: Record<string, unknown>) => {
				return isOverrideBranchOutdated({
					branchPackageJson: branchPkg,
					expectedOverrides: overrideEntries
				})
			},
			config,
			dir
		})
	}

	const totalClosedCount =
		catalogSyncResult.closedCount + overrideSyncResult.closedCount
	const totalRebuiltCount =
		catalogSyncResult.rebuiltCount + overrideSyncResult.rebuiltCount

	// 7. Create PRs
	const existingBranches = new Set(existingPrs.map((pr) => pr.headRefName))
	const adjustedExistingCount = existingPrs.length - totalClosedCount
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

	const totalExpected =
		prsToCreate +
		(overrideBranchUpdate && !existingBranches.has(overrideBranchUpdate.branch)
			? 1
			: 0)
	const failed = totalExpected - created

	return { created, failed, rebuilt: totalRebuiltCount }
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
	if (excludeDirectories.length > 0)
		console.log(`Exclude: ${excludeDirectories.join(', ')}`)
	console.log('')

	// 0. Fetch latest remote refs and remember the starting branch for recovery
	console.log('Fetching latest remote refs...')
	const fetchResult = await exec({ command: ['git', 'fetch', 'origin'], cwd })
	if (fetchResult.exitCode !== 0) {
		console.error('Failed to fetch from origin')
		process.exit(1)
	}
	const startBranch = (
		await exec({ command: ['git', 'branch', '--show-current'], cwd })
	).stdout.trim()

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

main().catch((error) => {
	console.error('Fatal error:', error)
	process.exit(1)
})
