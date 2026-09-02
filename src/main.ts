#!/usr/bin/env bun
import { BunFileSystem } from '@effect/platform-bun'
import { Config, Effect, Exit, Layer, Option, Schema } from 'effect'
import { version as packageVersion } from '../package.json'
import { Commands } from './commands'
import { discoverCatalogLocations } from './discover'
import { plainLoggerLayer } from './logging'
import { processCatalog } from './pipeline'
import { Registry } from './registry'

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

type CliOptions = {
	dryRun: boolean
	configPath: string
	excludeRaw: string
}

function failWith(message: string): never {
	console.error(message)
	process.exit(1)
}

/**
 * Parse CLI arguments. Help/version/unknown-option handling stays in the
 * process boundary: they exit the process directly, before any Effect runs.
 */
function parseArgs(): CliOptions {
	const options: CliOptions = {
		dryRun: false,
		configPath: '.catalog-updaterc.json',
		excludeRaw: ''
	}
	const args = process.argv.slice(2)

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
				options.dryRun = true
				break
			}
			case '--config':
			case '-c': {
				const value = args[i + 1]
				if (value === undefined) {
					failWith(`Missing value for ${arg}`)
				}
				options.configPath = value
				i++
				break
			}
			case '--exclude':
			case '-e': {
				const value = args[i + 1]
				if (value === undefined) {
					failWith(`Missing value for ${arg}`)
				}
				options.excludeRaw = value
				i++
				break
			}
			default: {
				if (arg.startsWith('-')) {
					console.error(`Unknown option: ${arg}`)
					failWith('Run with --help for usage information.')
				}
				break
			}
		}
	}

	return options
}

// ---------------------------------------------------------------------------
// Main program
// ---------------------------------------------------------------------------

/** git fetch failed before the run could start. */
// Schema.TaggedError declarations are class declarations, not throw sites;
// unicorn/throw-new-error misreads the TaggedError() constructor call as an
// un-newed throw.
// oxlint-disable-next-line unicorn/throw-new-error
class FetchFailed extends Schema.TaggedError<FetchFailed>()('FetchFailed', {
	cause: Schema.Defect()
}) {}

const mainProgram = Effect.fn('Main.run')(function* (
	options: CliOptions & { excludeDirectories: Array<string> }
) {
	const cwd = process.cwd()

	yield* Effect.logInfo('Catalog Dependency Updater')
	yield* Effect.logInfo(`Mode: ${options.dryRun ? 'DRY RUN' : 'LIVE'}`)
	yield* Effect.logInfo(`Config: ${options.configPath}`)
	if (options.excludeDirectories.length > 0) {
		yield* Effect.logInfo(`Exclude: ${options.excludeDirectories.join(', ')}`)
	}
	yield* Effect.logInfo('')

	const commands = yield* Commands

	// 0. Fetch latest remote refs and remember the starting branch for recovery
	yield* Effect.logInfo('Fetching latest remote refs...')
	const fetchResult = yield* commands.exec(['git', 'fetch', 'origin'], { cwd })
	if (fetchResult.exitCode !== 0) {
		return yield* new FetchFailed({ cause: fetchResult.stderr })
	}
	const startBranchResult = yield* commands.exec(
		['git', 'branch', '--show-current'],
		{ cwd }
	)
	const startBranch = startBranchResult.stdout.trim()

	// 1. Discover catalog locations
	yield* Effect.logInfo('\nDiscovering catalog locations...')
	const locations = yield* discoverCatalogLocations({
		cwd,
		excludePatterns: options.excludeDirectories
	})

	if (locations.length === 0) {
		yield* Effect.logInfo('No catalog definitions found.')
		return { totalCreated: 0, totalFailed: 0, totalRebuilt: 0 }
	}

	yield* Effect.logInfo(
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
	for (const location of locations) {
		const label =
			location.dir === '.'
				? `(root, ${location.providerId})`
				: `/${location.dir} (${location.providerId})`
		yield* Effect.logInfo(`\n${'='.repeat(60)}`)
		yield* Effect.logInfo(`Processing ${label}`)
		yield* Effect.logInfo('='.repeat(60))

		const result = yield* processCatalog({
			location,
			cwd,
			configPath: options.configPath,
			dryRun: options.dryRun
		}).pipe(
			// Best-effort recovery: return to a clean default branch state so
			// subsequent locations aren't processed from a stale branch.
			Effect.catchTag('GitError', (error) =>
				Effect.gen(function* () {
					yield* Effect.logError(
						`  Failed to process ${label}: ${String(error)}`
					)
					yield* commands.exec(['git', 'checkout', '--', '.'], { cwd })
					yield* commands.exec(['git', 'checkout', startBranch], { cwd })
					return { created: 0, failed: 1, rebuilt: 0 }
				})
			)
		)
		totalCreated += result.created
		totalFailed += result.failed
		totalRebuilt += result.rebuilt
	}

	// Restore the branch the run started on, so CLI users are not left parked
	// on the default branch after a successful run. In CI the checkout may be
	// detached (no current branch); only restore when there is one to return to.
	if (startBranch) {
		yield* commands.exec(['git', 'checkout', startBranch], { cwd })
	}

	// 3. Summary
	if (!options.dryRun) {
		const total = totalCreated + totalFailed
		yield* Effect.logInfo(`\n${'='.repeat(60)}`)
		yield* Effect.logInfo(
			`Summary: Created ${totalCreated}/${total} PRs, rebuilt ${totalRebuilt} existing PRs across ${locations.length} catalog ${locations.length === 1 ? 'definition' : 'definitions'}.`
		)
	}

	if (totalFailed > 0) {
		yield* Effect.logError(`\n${totalFailed} PR(s) failed to create.`)
	}

	return { totalCreated, totalFailed, totalRebuilt }
})

// Commands (git/gh/install/audit), the filesystem and the npm registry are
// the program's only service dependencies; the plain logger keeps output
// human-readable.
const runtimeLayer = Layer.mergeAll(
	Commands.layer,
	BunFileSystem.layer,
	Registry.layer,
	plainLoggerLayer
)

// The async entry function and its awaits are the process boundary: the CLI
// awaits one runPromise to derive the process exit code.
// oxlint-disable-next-line effect/noAsyncFunction
const run = async (): Promise<void> => {
	const options = parseArgs()

	const program = Effect.gen(function* () {
		// Prefer the environment variable (safe from shell injection in GitHub
		// Actions), fall back to the CLI arg for local usage.
		const envExclude = yield* Config.option(
			Config.string('CATALOG_UPDATE_EXCLUDE')
		)
		const rawExclude = Option.isSome(envExclude)
			? envExclude.value
			: options.excludeRaw
		const excludeDirectories = rawExclude
			? rawExclude
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
			: []

		return yield* mainProgram({ ...options, excludeDirectories })
	})

	// oxlint-disable-next-line effect/noAsyncFunction
	const exit = await Effect.runPromiseExit(
		program.pipe(Effect.provide(runtimeLayer))
	)

	if (Exit.isFailure(exit)) {
		console.error('Fatal error:', exit.cause)
		process.exit(1)
	}
	if (exit.value.totalFailed > 0) {
		process.exit(1)
	}
}

// oxlint-disable-next-line effect/noAsyncFunction
await run()
