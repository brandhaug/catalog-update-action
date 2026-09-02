import { Effect, FileSystem, Option } from 'effect'
import { matchesAnyPattern } from './utils'
import { getProvider, type ProviderId } from './providers'
import { type CatalogLocation } from './types'

/**
 * Files that may define catalogs, and the package manager whose format they
 * speak. Each match becomes an independently processed catalog location.
 */
const DEFINITION_FILES: Array<{ glob: string; providerId: ProviderId }> = [
	{ glob: '**/package.json', providerId: 'bun' },
	{ glob: '**/pnpm-workspace.yaml', providerId: 'pnpm' },
	{ glob: '**/.yarnrc.yml', providerId: 'yarn' }
]

/** Sort helper keeping the repo root ('.') first. */
function compareDirs(a: string, b: string): number {
	if (a < b) {
		return -1
	}
	return a > b ? 1 : 0
}

/** Collect every path matched by a Bun glob, relative to `cwd`. */
const scanGlob = (glob: string, cwd: string): Effect.Effect<Array<string>> =>
	Effect.promise(() =>
		// Bun.Glob is the Bun platform's glob capability; Effect's FileSystem
		// service has no directory search, and discovery is the adapter where
		// the runtime's own scanner is the tool.
		// oxlint-disable-next-line effect/noGlobals
		Array.fromAsync(new Bun.Glob(glob).scan({ cwd, dot: true }))
	)

/**
 * Discovers every catalog definition in the repository: package.json files
 * with a `catalog` field (bun), pnpm-workspace.yaml (pnpm) and .yarnrc.yml
 * (yarn). Skips node_modules, dotfile directories and exclude patterns.
 * Returns locations sorted by directory, then catalog name. Unreadable or
 * unparseable files are warned about and skipped.
 */
export const discoverCatalogLocations = Effect.fn('Discover.catalogLocations')(
	function* ({
		cwd,
		excludePatterns
	}: {
		cwd: string
		excludePatterns: Array<string>
	}) {
		const fs = yield* FileSystem.FileSystem
		const locations: Array<CatalogLocation> = []

		for (const { glob, providerId } of DEFINITION_FILES) {
			const provider = getProvider(providerId)
			const paths = yield* scanGlob(glob, cwd)

			for (const path of paths) {
				const segments = path.split('/')
				if (segments.includes('node_modules')) {
					continue
				}
				// Skip dotfile *directories* (e.g. .github, .devcontainer). The
				// basename is exempt so root dotfiles like .yarnrc.yml are found.
				const dirSegments = segments.slice(0, -1)
				if (dirSegments.some((segment) => segment.startsWith('.'))) {
					continue
				}

				const dir = segments.length === 1 ? '.' : dirSegments.join('/')
				if (
					excludePatterns.length > 0 &&
					matchesAnyPattern({ name: dir, patterns: excludePatterns })
				) {
					continue
				}

				const content = yield* fs
					.readFileString(`${cwd}/${path}`)
					.pipe(Effect.option)
				if (Option.isNone(content)) {
					yield* Effect.logWarning(
						`  Warning: could not read ${path}: file unavailable`
					)
					continue
				}

				const parsed = yield* Effect.try({
					try: () => provider.parseDefinitions({ content: content.value }),
					catch: String
				}).pipe(Effect.result)
				if (parsed._tag === 'Failure') {
					yield* Effect.logWarning(
						`  Warning: could not parse ${path}: ${parsed.failure}`
					)
					continue
				}

				for (const definition of parsed.success) {
					locations.push({
						dir,
						providerId,
						definitionRelPath: path,
						definition
					})
				}
			}
		}

		// Plain code-unit directory comparison keeps '.' (the repo root) first,
		// matching the previous directory-only discovery order.
		return locations.toSorted(
			(a, b) =>
				compareDirs(a.dir, b.dir) ||
				a.definition.catalogName.localeCompare(b.definition.catalogName)
		)
	}
)
