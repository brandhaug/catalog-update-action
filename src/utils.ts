import type { SemverChange } from './types'
export type { SemverChange } from './types'

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

export function parseSemver({ version }: { version: string }): { major: number; minor: number; patch: number; prerelease?: string } | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?/)
  if (!match) return null
  const result: { major: number; minor: number; patch: number; prerelease?: string } = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  }
  if (match[4]) result.prerelease = match[4]
  return result
}

/** Compare prerelease identifiers per semver 2.0.0 spec: release > prerelease, numeric < string, left-to-right. */
function comparePrerelease(a?: string, b?: string): number {
  if (a === b) return 0
  // release (no prerelease) > prerelease
  if (!a) return 1
  if (!b) return -1

  const partsA = a.split('.')
  const partsB = b.split('.')
  const len = Math.max(partsA.length, partsB.length)

  for (let i = 0; i < len; i++) {
    const pa = partsA[i]
    const pb = partsB[i]
    // Fewer identifiers < more identifiers when all preceding are equal
    if (pa === undefined) return -1
    if (pb === undefined) return 1

    const numA = /^\d+$/.test(pa) ? Number(pa) : null
    const numB = /^\d+$/.test(pb) ? Number(pb) : null

    if (numA !== null && numB !== null) {
      if (numA !== numB) return numA - numB
    } else if (numA !== null) {
      return -1 // numeric < string
    } else if (numB !== null) {
      return 1 // string > numeric
    } else {
      const cmp = pa.localeCompare(pb)
      if (cmp !== 0) return cmp
    }
  }

  return 0
}

export function classifySemverChange({ from, to }: { from: string; to: string }): SemverChange | null {
  const a = parseSemver({ version: from })
  const b = parseSemver({ version: to })
  if (!a || !b) return null
  if (b.major > a.major) return 'major'
  if (b.major < a.major) return null
  if (b.minor > a.minor) return 'minor'
  if (b.minor < a.minor) return null
  if (b.patch > a.patch) return a.prerelease ? 'prerelease' : 'patch'
  if (b.patch < a.patch) return null
  // Same major.minor.patch — compare prerelease
  const cmp = comparePrerelease(a.prerelease, b.prerelease)
  if (cmp < 0) return 'prerelease'
  return null
}

export function compareSemver({ a, b }: { a: string; b: string }): number {
  const pa = parseSemver({ version: a })
  const pb = parseSemver({ version: b })
  if (!pa || !pb) return 0
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  if (pa.patch !== pb.patch) return pa.patch - pb.patch
  return comparePrerelease(pa.prerelease, pb.prerelease)
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
 * Excludes pre-releases unless `includePrerelease` is set. Caps at maxVersions.
 * Falls back to [latestVersion] if no intermediate versions found.
 */
export function getIntermediateVersions({
  publishedVersions,
  currentVersion,
  latestVersion,
  maxVersions = 10,
  includePrerelease = false
}: {
  publishedVersions: string[]
  currentVersion: string
  latestVersion: string
  maxVersions?: number
  includePrerelease?: boolean
}): string[] {
  const intermediate = publishedVersions
    .filter((v) => {
      if (!includePrerelease && v.includes('-')) return false
      if (!parseSemver({ version: v })) return false
      return compareSemver({ a: currentVersion, b: v }) < 0 && compareSemver({ a: v, b: latestVersion }) <= 0
    })
    .sort((a, b) => compareSemver({ a: b, b: a }))
    .slice(0, maxVersions)

  if (intermediate.length === 0) return [latestVersion]
  return intermediate
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

export const PR_FOOTER = '*This PR was auto-generated by [catalog-update-action](https://github.com/brandhaug/catalog-update-action).*'

export function getOverrideBranchPrefix({ branchPrefix }: { branchPrefix: string }): string {
  return `${branchPrefix}-override`
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
