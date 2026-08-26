import { type CatalogEntry } from './types'
import { parseSemver } from './utils'

/** Detect the range prefix (`^`, `~`) or empty string for a pinned version. */
function detectRangePrefix(raw: string): '^' | '~' | '' {
	if (raw.startsWith('^')) return '^'
	if (raw.startsWith('~')) return '~'
	return ''
}

/** Parse the `catalog` field from package.json into structured entries. */
export function parseCatalog({
	catalog
}: {
	catalog: Record<string, string>
}): CatalogEntry[] {
	const entries: CatalogEntry[] = []

	for (const [name, raw] of Object.entries(catalog)) {
		// Handle npm: aliases (e.g., "npm:rolldown-vite@7.3.1" or "npm:rolldown-vite@^7.3.1")
		const aliasMatch = raw.match(/^npm:(.+)@(.+)$/)
		const aliasNpmName = aliasMatch?.[1]
		const aliasVersion = aliasMatch?.[2]
		if (aliasNpmName && aliasVersion) {
			const aliasPrefix = detectRangePrefix(aliasVersion)
			const cleanVersion = aliasPrefix ? aliasVersion.slice(1) : aliasVersion
			if (!parseSemver({ version: cleanVersion })) continue

			entries.push({
				name,
				npmName: aliasNpmName,
				currentVersion: cleanVersion,
				rangePrefix: aliasPrefix,
				isAlias: true
			})
			continue
		}

		// Handle range prefixes (e.g., "^6.1.1" or "~6.1.1")
		const rangePrefix = detectRangePrefix(raw)
		const version = rangePrefix ? raw.slice(1) : raw

		if (!parseSemver({ version })) continue

		entries.push({
			name,
			npmName: name,
			currentVersion: version,
			rangePrefix,
			isAlias: false
		})
	}

	return entries
}
