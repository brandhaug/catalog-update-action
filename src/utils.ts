// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

const globCache = new Map<string, RegExp>()

/** Simple glob matcher — only `*` (zero or more characters) is supported. */
export function matchesGlob({ name, pattern }: { name: string; pattern: string }): boolean {
  let regex = globCache.get(pattern)
  if (!regex) {
    const escaped = pattern
      .replaceAll(/[.+^${}()|[\]\\]/g, '\\$&')
      .replaceAll('*', '.*')
    regex = new RegExp(`^${escaped}$`)
    globCache.set(pattern, regex)
  }
  return regex.test(name)
}

export function matchesAnyPattern({ name, patterns }: { name: string; patterns: string[] }): boolean {
  return patterns.some((pattern) => matchesGlob({ name, pattern }))
}

// ---------------------------------------------------------------------------
// Semver utilities
// ---------------------------------------------------------------------------

export function parseSemver({ version }: { version: string }): { major: number; minor: number; patch: number } | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export type SemverChange = 'major' | 'minor' | 'patch'

export function classifySemverChange({ from, to }: { from: string; to: string }): SemverChange | null {
  const a = parseSemver({ version: from })
  const b = parseSemver({ version: to })
  if (!a || !b) return null
  if (b.major > a.major) return 'major'
  if (b.major < a.major) return null
  if (b.minor > a.minor) return 'minor'
  if (b.minor < a.minor) return null
  if (b.patch > a.patch) return 'patch'
  return null
}

export function compareSemver({ a, b }: { a: string; b: string }): number {
  const pa = parseSemver({ version: a })
  const pb = parseSemver({ version: b })
  if (!pa || !pb) return 0
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  return pa.patch - pb.patch
}

/** Parse version from GitHub release tag formats: v1.2.3, 1.2.3, name@1.2.3, @scope/name@1.2.3 */
export function extractVersionFromTag({ tag }: { tag: string }): string | null {
  const atMatch = tag.match(/@(\d+\.\d+\.\d+.*)$/)
  if (atMatch?.[1]) return atMatch[1]
  const vMatch = tag.match(/^v?(\d+\.\d+\.\d+.*)$/)
  if (vMatch?.[1]) return vMatch[1]
  return null
}

/**
 * Return versions where current < version <= latest, sorted descending (newest first).
 * Excludes pre-releases, caps at maxVersions.
 * Falls back to [latestVersion] if no intermediate versions found.
 */
export function getIntermediateVersions({
  publishedVersions,
  currentVersion,
  latestVersion,
  maxVersions = 10
}: {
  publishedVersions: string[]
  currentVersion: string
  latestVersion: string
  maxVersions?: number
}): string[] {
  const intermediate = publishedVersions
    .filter((v) => {
      if (v.includes('-')) return false
      if (!parseSemver({ version: v })) return false
      return compareSemver({ a: currentVersion, b: v }) < 0 && compareSemver({ a: v, b: latestVersion }) <= 0
    })
    .sort((a, b) => compareSemver({ a: b, b: a }))
    .slice(0, maxVersions)

  if (intermediate.length === 0) return [latestVersion]
  return intermediate
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

export class Semaphore {
  private queue: Array<() => void> = []
  private running = 0

  constructor(private concurrency: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++
        resolve()
      })
    })
  }

  release(): void {
    this.running--
    const next = this.queue.shift()
    if (next) next()
  }
}
