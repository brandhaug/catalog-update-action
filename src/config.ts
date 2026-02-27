import type { Config, GroupDefinition, IgnoreRule, SemverChange } from './types'

const DEFAULT_CONFIG: Config = {
  branchPrefix: 'catalog-update',
  defaultBranch: 'master',
  maxOpenPrs: 20,
  concurrency: 10,
  packageManager: 'bun',
  groups: [],
  ignore: []
}

const VALID_PACKAGE_MANAGERS = new Set(['bun', 'npm', 'pnpm', 'yarn'])
const VALID_UPDATE_TYPES = new Set<SemverChange>(['major', 'minor', 'patch'])

function parseUpdateTypes({ raw }: { raw: unknown }): SemverChange[] | null {
  if (raw === null || raw === undefined) return null
  if (!Array.isArray(raw)) return null

  const valid = raw.filter((item): item is SemverChange => VALID_UPDATE_TYPES.has(item as SemverChange))
  return valid.length > 0 ? valid : null
}

function parseGroups({ raw }: { raw: unknown }): GroupDefinition[] {
  if (!Array.isArray(raw)) return []

  return raw
    .filter((g): g is Record<string, unknown> => typeof g === 'object' && g !== null)
    .filter((g) => typeof g.name === 'string' && Array.isArray(g.patterns))
    .map((g) => ({
      name: g.name as string,
      patterns: (g.patterns as unknown[]).filter((p): p is string => typeof p === 'string'),
      updateTypes: parseUpdateTypes({ raw: g.updateTypes })
    }))
}

function parseIgnoreRules({ raw }: { raw: unknown }): IgnoreRule[] {
  if (!Array.isArray(raw)) return []

  return raw
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .filter((r) => typeof r.pattern === 'string')
    .map((r) => ({
      pattern: r.pattern as string,
      updateTypes: parseUpdateTypes({ raw: r.updateTypes })
    }))
}

export async function loadConfig({ configPath }: { configPath: string }): Promise<Config> {
  try {
    const file = Bun.file(configPath)
    const exists = await file.exists()

    if (!exists) {
      console.warn(`Config file not found at ${configPath}, using defaults`)
      return DEFAULT_CONFIG
    }

    const raw = (await file.json()) as Record<string, unknown>

    return {
      branchPrefix: typeof raw.branchPrefix === 'string' ? raw.branchPrefix : DEFAULT_CONFIG.branchPrefix,
      defaultBranch: typeof raw.defaultBranch === 'string' ? raw.defaultBranch : DEFAULT_CONFIG.defaultBranch,
      maxOpenPrs: typeof raw.maxOpenPrs === 'number' ? raw.maxOpenPrs : DEFAULT_CONFIG.maxOpenPrs,
      concurrency: typeof raw.concurrency === 'number' ? raw.concurrency : DEFAULT_CONFIG.concurrency,
      packageManager: VALID_PACKAGE_MANAGERS.has(raw.packageManager as string)
        ? (raw.packageManager as Config['packageManager'])
        : DEFAULT_CONFIG.packageManager,
      groups: parseGroups({ raw: raw.groups }),
      ignore: parseIgnoreRules({ raw: raw.ignore })
    }
  } catch (error) {
    console.error(`Failed to load config from ${configPath}:`, error)
    return DEFAULT_CONFIG
  }
}
