import { matchesAnyPattern } from './utils'
import { getProvider, type ParsedCatalog, type ProviderId } from './providers'
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

/**
 * Discovers every catalog definition in the repository: package.json files
 * with a `catalog` field (bun), pnpm-workspace.yaml (pnpm) and .yarnrc.yml
 * (yarn). Skips node_modules, dotfile directories and exclude patterns.
 * Returns locations sorted by directory, then catalog name.
 */
export async function discoverCatalogLocations({
	cwd,
	excludePatterns
}: {
	cwd: string
	excludePatterns: Array<string>
}): Promise<Array<CatalogLocation>> {
	const locations: Array<CatalogLocation> = []

	/* oxlint-disable no-await-in-loop */
	for (const { glob, providerId } of DEFINITION_FILES) {
		const provider = getProvider(providerId)
		const scanner = new Bun.Glob(glob)

		for await (const path of scanner.scan({ cwd, dot: true })) {
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

			let content: string
			try {
				content = await Bun.file(`${cwd}/${path}`).text()
			} catch (error: unknown) {
				console.warn(`  Warning: could not read ${path}: ${String(error)}`)
				continue
			}

			let definitions: Array<ParsedCatalog>
			try {
				definitions = provider.parseDefinitions({ content })
			} catch (error: unknown) {
				console.warn(`  Warning: could not parse ${path}: ${String(error)}`)
				continue
			}

			for (const definition of definitions) {
				locations.push({ dir, providerId, definitionRelPath: path, definition })
			}
		}
	}
	/* oxlint-enable no-await-in-loop */

	// Plain code-unit directory comparison keeps '.' (the repo root) first,
	// matching the previous directory-only discovery order.
	return locations.toSorted(
		(a, b) =>
			compareDirs(a.dir, b.dir) ||
			a.definition.catalogName.localeCompare(b.definition.catalogName)
	)
}
