import type { CatalogEntry } from './types'
import { parseSemver } from './utils'

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
			const aliasPrefix = aliasVersion.startsWith('^')
				? ('^' as const)
				: aliasVersion.startsWith('~')
					? ('~' as const)
					: ('' as const)
			const cleanVersion = aliasPrefix ? aliasVersion.slice(1) : aliasVersion
			if (!parseSemver({ version: cleanVersion })) continue

			entries.push({
				name,
				raw,
				npmName: aliasNpmName,
				currentVersion: cleanVersion,
				rangePrefix: aliasPrefix,
				isAlias: true,
				aliasName: aliasNpmName
			})
			continue
		}

		// Handle range prefixes (e.g., "^6.1.1" or "~6.1.1")
		const rangePrefix = raw.startsWith('^')
			? ('^' as const)
			: raw.startsWith('~')
				? ('~' as const)
				: ('' as const)
		const version = rangePrefix ? raw.slice(1) : raw

		if (!parseSemver({ version })) continue

		entries.push({
			name,
			raw,
			npmName: name,
			currentVersion: version,
			rangePrefix,
			isAlias: false,
			aliasName: null
		})
	}

	return entries
}
