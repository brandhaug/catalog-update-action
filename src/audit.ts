import type { AuditAdvisory, AuditResult, BranchUpdate, OverrideEntry, Severity } from './types'
import { compareSemver, getOverrideBranchPrefix, PR_FOOTER } from './utils'

// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4
}

// ---------------------------------------------------------------------------
// Run bun audit
// ---------------------------------------------------------------------------

/**
 * Runs `bun audit --json` and returns parsed results.
 * Uses Bun.spawn directly instead of the exec helper because bun audit
 * returns a non-zero exit code when vulnerabilities are found, which is
 * the expected (successful) case — exec would log misleading errors.
 */
export async function runAudit({ cwd }: { cwd: string }): Promise<AuditResult | null> {
  const proc = Bun.spawn(['bun', 'audit', '--json'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env
  })

  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited

  const output = (stdout || stderr).trim()
  if (!output) {
    console.warn('  bun audit returned empty output')
    return null
  }

  try {
    const parsed: unknown = JSON.parse(output)

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('  bun audit returned unexpected JSON format')
      return null
    }

    return parsed as AuditResult
  } catch {
    console.warn('  Failed to parse bun audit output')
    return null
  }
}

// ---------------------------------------------------------------------------
// Parse fixed version from vulnerable_versions range
// ---------------------------------------------------------------------------

/**
 * Extracts upper bounds from semver ranges using `<` (strict less-than).
 * The regex requires a digit immediately after `<`, which naturally excludes
 * `<=` bounds (where the bound version itself is vulnerable).
 * Returns the highest version found, or null if no `<` bound exists.
 *
 * Examples:
 *   "<1.30.0" → "1.30.0"
 *   ">=0.3.41 <0.4.6" → "0.4.6"
 *   ">=0.3.41 <0.4.6 || >=0.5.0 <0.5.3" → "0.5.3"
 */
export function parseFixedVersion({ vulnerableVersions }: { vulnerableVersions: string }): string | null {
  const strictBounds: string[] = []
  // Matches `<` followed immediately by a semver version (digit).
  // This naturally excludes `<=` since `=` is not a digit.
  const regex = /<(\d+\.\d+\.\d+(?:-[\w.]+)?)/g
  let m: RegExpExecArray | null

  while ((m = regex.exec(vulnerableVersions)) !== null) {
    strictBounds.push(m[1]!)
  }

  if (strictBounds.length === 0) return null
  if (strictBounds.length === 1) return strictBounds[0]!

  return strictBounds.reduce((highest, v) => (compareSemver({ a: v, b: highest }) > 0 ? v : highest))
}

// ---------------------------------------------------------------------------
// Compute overrides from audit results
// ---------------------------------------------------------------------------

export function computeOverrides({
  auditResult,
  catalogNames,
  minimumSeverity,
  existingOverrides
}: {
  auditResult: AuditResult
  catalogNames: Set<string>
  minimumSeverity: Severity
  existingOverrides: Record<string, string>
}): OverrideEntry[] {
  const minLevel = SEVERITY_ORDER[minimumSeverity]
  const entries: OverrideEntry[] = []

  for (const [packageName, advisories] of Object.entries(auditResult)) {
    if (catalogNames.has(packageName)) continue

    const qualifying = advisories.filter((a) => SEVERITY_ORDER[a.severity] >= minLevel)
    if (qualifying.length === 0) continue

    // Collect all fixed versions from qualifying advisories
    const fixedVersions: { version: string; advisory: AuditAdvisory }[] = []
    for (const advisory of qualifying) {
      const fixed = parseFixedVersion({ vulnerableVersions: advisory.vulnerable_versions })
      if (fixed) fixedVersions.push({ version: fixed, advisory })
    }

    if (fixedVersions.length === 0) continue

    // Take the highest fixed version
    const highest = fixedVersions.reduce((best, curr) =>
      compareSemver({ a: curr.version, b: best.version }) > 0 ? curr : best
    )

    // Skip if existing override is already at or above the fixed version
    const existing = existingOverrides[packageName]
    if (existing && compareSemver({ a: existing, b: highest.version }) >= 0) continue

    entries.push({
      packageName,
      fixedVersion: highest.version,
      advisories: qualifying
    })
  }

  return entries
}

// ---------------------------------------------------------------------------
// Build override PR body
// ---------------------------------------------------------------------------

export function buildOverridePrBody({ overrides }: { overrides: OverrideEntry[] }): string {
  const sorted = [...overrides].sort((a, b) => a.packageName.localeCompare(b.packageName))

  const lines = [
    '## Vulnerability Overrides',
    '',
    '| Package | Fixed Version | Severity | Advisory |',
    '| --- | --- | --- | --- |',
    ...sorted.map((o) => {
      const severities = [...new Set(o.advisories.map((a) => a.severity))].join(', ')
      const urls = o.advisories.map((a) => `[${a.id}](${a.url})`).join(', ')
      return `| \`${o.packageName}\` | ${o.fixedVersion} | ${severities} | ${urls} |`
    }),
    ''
  ]

  // Advisory details in collapsible sections
  for (const override of sorted) {
    lines.push(`<details>`)
    lines.push(`<summary>${override.packageName} — ${override.advisories.length} advisory(ies)</summary>`)
    lines.push('')
    for (const advisory of override.advisories) {
      lines.push(`### ${advisory.title}`)
      lines.push(`- **Severity**: ${advisory.severity} (CVSS ${advisory.cvss.score})`)
      lines.push(`- **Vulnerable versions**: \`${advisory.vulnerable_versions}\``)
      if (advisory.cwe.length > 0) {
        lines.push(`- **CWE**: ${advisory.cwe.join(', ')}`)
      }
      lines.push(`- **Advisory**: ${advisory.url}`)
      lines.push('')
    }
    lines.push('</details>')
    lines.push('')
  }

  lines.push(`> Override entries are added to \`package.json#overrides\` to pin transitive dependencies to patched versions.`)
  lines.push(`> See [Bun overrides documentation](https://bun.sh/docs/install/overrides) for details.`)
  lines.push('')
  lines.push('---')
  lines.push(PR_FOOTER)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Build BranchUpdate for overrides
// ---------------------------------------------------------------------------

export function buildOverrideBranchUpdate({
  overrides,
  branchPrefix
}: {
  overrides: OverrideEntry[]
  branchPrefix: string
}): BranchUpdate {
  const n = overrides.length
  const title = `fix(security): override ${n} vulnerable transitive ${n === 1 ? 'dependency' : 'dependencies'}`
  const body = buildOverridePrBody({ overrides })
  const branch = `${getOverrideBranchPrefix({ branchPrefix })}/vulnerability-fixes`

  return {
    branch,
    title,
    body,
    applyChanges: (packageJson: Record<string, unknown>) => {
      const current = (packageJson.overrides as Record<string, string> | undefined) ?? {}
      const merged = { ...current }
      for (const entry of overrides) {
        merged[entry.packageName] = entry.fixedVersion
      }
      packageJson.overrides = merged
    }
  }
}

// ---------------------------------------------------------------------------
// Check if override branch is outdated
// ---------------------------------------------------------------------------

export function isOverrideBranchOutdated({
  branchPackageJson,
  expectedOverrides
}: {
  branchPackageJson: Record<string, unknown>
  expectedOverrides: OverrideEntry[]
}): boolean {
  const overrides = branchPackageJson.overrides as Record<string, string> | undefined
  if (!overrides) return true

  for (const entry of expectedOverrides) {
    if (overrides[entry.packageName] !== entry.fixedVersion) return true
  }

  return false
}
