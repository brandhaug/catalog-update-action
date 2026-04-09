import type {
	AuditResult,
	BranchUpdate,
	OverrideEntry,
	Severity
} from './types'
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
export async function runAudit({
	cwd
}: {
	cwd: string
}): Promise<AuditResult | null> {
	const proc = Bun.spawn(['bun', 'audit', '--json'], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		env: process.env
	})

	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text()
	])
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
export function parseFixedVersion({
	vulnerableVersions
}: {
	vulnerableVersions: string
}): string | null {
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

	return strictBounds.reduce((highest, v) =>
		compareSemver({ a: v, b: highest }) > 0 ? v : highest
	)
}

// ---------------------------------------------------------------------------
// Override key helper
// ---------------------------------------------------------------------------

export function overrideKey(
	entry: Pick<OverrideEntry, 'packageName' | 'vulnerableRange'>
): string {
	return `${entry.packageName}@${entry.vulnerableRange}`
}

/**
 * Returns true if the key matches the tool-generated format `name@<range>`.
 * User-added overrides use plain package names (e.g. `some-package`), while
 * tool-generated keys always contain `@` followed by a semver comparator.
 * Note: a user override manually written as `pkg@<range>` would be treated
 * as tool-generated and subject to cleanup.
 */
export function isToolOverrideKey(key: string): boolean {
	return /^.+@[<>=]/.test(key)
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

	// Group by (packageName, vulnerable_versions) — each unique pair becomes one override entry
	const groupMap = new Map<string, OverrideEntry>()

	for (const [packageName, advisories] of Object.entries(auditResult)) {
		if (catalogNames.has(packageName)) continue

		for (const advisory of advisories) {
			if (SEVERITY_ORDER[advisory.severity] < minLevel) continue

			const fixed = parseFixedVersion({
				vulnerableVersions: advisory.vulnerable_versions
			})
			if (!fixed) continue

			const groupKey = overrideKey({
				packageName,
				vulnerableRange: advisory.vulnerable_versions
			})
			const existing = groupMap.get(groupKey)

			if (existing) {
				existing.advisories.push(advisory)
				// Keep the highest fixed version within the group
				if (compareSemver({ a: fixed, b: existing.fixedVersion }) > 0) {
					existing.fixedVersion = fixed
				}
			} else {
				groupMap.set(groupKey, {
					packageName,
					vulnerableRange: advisory.vulnerable_versions,
					fixedVersion: fixed,
					advisories: [advisory]
				})
			}
		}
	}

	const entries: OverrideEntry[] = []

	for (const group of groupMap.values()) {
		const existingVersion = existingOverrides[overrideKey(group)]
		if (
			existingVersion &&
			compareSemver({ a: existingVersion, b: group.fixedVersion }) >= 0
		) {
			// The override exists in package.json but bun audit still reports the
			// vulnerability — the lockfile wasn't re-resolved after the override was
			// added.  Include it so the PR branch can delete the lockfile and reinstall.
			group.existingOverrideStale = true
		}

		entries.push(group)
	}

	return entries
}

// ---------------------------------------------------------------------------
// Build override PR body
// ---------------------------------------------------------------------------

export function buildOverridePrBody({
	overrides
}: {
	overrides: OverrideEntry[]
}): string {
	const sorted = [...overrides].sort(
		(a, b) =>
			a.packageName.localeCompare(b.packageName) ||
			a.vulnerableRange.localeCompare(b.vulnerableRange)
	)

	const lines = [
		'## Vulnerability Overrides',
		'',
		'| Package | Vulnerable Range | Fixed Version | Severity | Advisory |',
		'| --- | --- | --- | --- | --- |',
		...sorted.map((o) => {
			const severities = [...new Set(o.advisories.map((a) => a.severity))].join(
				', '
			)
			const urls = o.advisories.map((a) => `[${a.id}](${a.url})`).join(', ')
			return `| \`${o.packageName}\` | \`${o.vulnerableRange}\` | ${o.fixedVersion} | ${severities} | ${urls} |`
		}),
		''
	]

	// Advisory details in collapsible sections
	for (const override of sorted) {
		lines.push(`<details>`)
		lines.push(
			`<summary>${override.packageName} — ${override.advisories.length} advisory(ies)</summary>`
		)
		lines.push('')
		for (const advisory of override.advisories) {
			lines.push(`### ${advisory.title}`)
			lines.push(
				`- **Severity**: ${advisory.severity} (CVSS ${advisory.cvss.score})`
			)
			lines.push(
				`- **Vulnerable versions**: \`${advisory.vulnerable_versions}\``
			)
			if (advisory.cwe.length > 0) {
				lines.push(`- **CWE**: ${advisory.cwe.join(', ')}`)
			}
			lines.push(`- **Advisory**: ${advisory.url}`)
			lines.push('')
		}
		lines.push('</details>')
		lines.push('')
	}

	lines.push(
		`> Override entries are added to \`package.json#overrides\` to pin transitive dependencies to patched versions.`
	)
	lines.push(
		`> See [Bun overrides documentation](https://bun.sh/docs/install/overrides) for details.`
	)
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
	branchPrefix,
	titleSuffix = ''
}: {
	overrides: OverrideEntry[]
	branchPrefix: string
	titleSuffix?: string
}): BranchUpdate {
	const n = overrides.length
	const title = `fix(security): override ${n} vulnerable transitive ${n === 1 ? 'dependency' : 'dependencies'}${titleSuffix}`
	const body = buildOverridePrBody({ overrides })
	const branch = `${getOverrideBranchPrefix({ branchPrefix })}/vulnerability-fixes`

	return {
		branch,
		title,
		body,
		deleteLockfile: true,
		applyChanges: (packageJson: Record<string, unknown>) => {
			const current =
				(packageJson.overrides as Record<string, string> | undefined) ?? {}
			const result: Record<string, string> = {}

			// Preserve user-added overrides (non-tool keys)
			for (const [key, value] of Object.entries(current)) {
				if (!isToolOverrideKey(key)) {
					result[key] = value
				}
			}

			// Add currently needed tool overrides
			for (const entry of overrides) {
				result[overrideKey(entry)] = entry.fixedVersion
			}

			if (Object.keys(result).length > 0) {
				packageJson.overrides = result
			} else {
				delete packageJson.overrides
			}
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
	const overrides = branchPackageJson.overrides as
		| Record<string, string>
		| undefined
	if (!overrides) return expectedOverrides.length > 0

	// Check all expected overrides are present with correct versions
	for (const entry of expectedOverrides) {
		if (overrides[overrideKey(entry)] !== entry.fixedVersion) return true
	}

	// Check for stale tool-generated overrides that are no longer needed
	const expectedKeys = new Set(expectedOverrides.map((e) => overrideKey(e)))
	for (const key of Object.keys(overrides)) {
		if (isToolOverrideKey(key) && !expectedKeys.has(key)) return true
	}

	return false
}
