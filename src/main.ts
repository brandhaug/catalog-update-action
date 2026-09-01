#!/usr/bin/env bun
import { version as packageVersion } from '../package.json'
import { exec } from './git'
import { discoverCatalogLocations } from './discover'
import { processCatalog } from './pipeline'

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const HELP_TEXT = `
catalog-update — Automated dependency updates for the catalog: protocol
(Bun, pnpm and Yarn catalogs)

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

function takeValue(args: Array<string>, index: number, option: string): string {
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
		if (arg === undefined) {
			break
		}

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

	// 1. Discover catalog locations
	console.log('\nDiscovering catalog locations...')
	const locations = await discoverCatalogLocations({
		cwd,
		excludePatterns: excludeDirectories
	})

	if (locations.length === 0) {
		console.log('No catalog definitions found.')
		return
	}

	console.log(
		`Found ${locations.length} catalog ${locations.length === 1 ? 'definition' : 'definitions'}: ${locations
			.map(
				(l) =>
					`${l.dir === '.' ? '.' : `/${l.dir}`} (${l.providerId}${l.definition.catalogName === 'default' ? '' : `:${l.definition.catalogName}`})`
			)
			.join(', ')}`
	)

	// 2. Process each location
	let totalCreated = 0
	let totalFailed = 0
	let totalRebuilt = 0

	// Locations are processed one at a time on purpose: each one checks out
	// branches and runs installs in the shared working tree, so running them
	// concurrently would race the same files.
	/* oxlint-disable no-await-in-loop */
	for (const location of locations) {
		const label =
			location.dir === '.'
				? `(root, ${location.providerId})`
				: `/${location.dir} (${location.providerId})`
		console.log(`\n${'='.repeat(60)}`)
		console.log(`Processing ${label}`)
		console.log('='.repeat(60))

		try {
			const result = await processCatalog({
				location,
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
			// subsequent locations aren't processed from a stale branch.
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
			`Summary: Created ${totalCreated}/${total} PRs, rebuilt ${totalRebuilt} existing PRs across ${locations.length} catalog ${locations.length === 1 ? 'definition' : 'definitions'}.`
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
