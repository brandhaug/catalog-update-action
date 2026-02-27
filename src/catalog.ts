import type { CatalogEntry } from './types'
import { parseSemver } from './utils'

/** Parse the `catalog` field from package.json into structured entries. */
export function parseCatalog({ catalog }: { catalog: Record<string, string> }): CatalogEntry[] {
  const entries: CatalogEntry[] = []

  for (const [name, raw] of Object.entries(catalog)) {
    // Skip pre-release versions (e.g., @typescript/native-preview with -dev.123 in version)
    if (/\d-(?:dev|alpha|beta|rc|canary|next|preview)(?:[.\d]|$)/.test(raw)) {
      continue
    }

    // Handle npm: aliases (e.g., "npm:rolldown-vite@7.3.1" or "npm:rolldown-vite@^7.3.1")
    const aliasMatch = raw.match(/^npm:(.+)@(.+)$/)
    const aliasNpmName = aliasMatch?.[1]
    const aliasVersion = aliasMatch?.[2]
    if (aliasNpmName && aliasVersion) {
      const aliasCaret = aliasVersion.startsWith('^')
      const cleanVersion = aliasCaret ? aliasVersion.slice(1) : aliasVersion
      if (!parseSemver({ version: cleanVersion })) continue

      entries.push({
        name,
        raw,
        npmName: aliasNpmName,
        currentVersion: cleanVersion,
        hasCaret: aliasCaret,
        isAlias: true,
        aliasName: aliasNpmName
      })
      continue
    }

    // Handle caret ranges (e.g., "^6.1.1")
    const hasCaret = raw.startsWith('^')
    const version = hasCaret ? raw.slice(1) : raw

    if (!parseSemver({ version })) continue

    entries.push({
      name,
      raw,
      npmName: name,
      currentVersion: version,
      hasCaret,
      isAlias: false,
      aliasName: null
    })
  }

  return entries
}
