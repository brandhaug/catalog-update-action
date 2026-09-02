import { Effect, FileSystem, Option } from 'effect'

import { Commands } from './commands'
import {
	type AuditCapability,
	expectedInstallBasenames,
	getProvider,
	type ProviderId
} from './providers'
import {
	BranchApplyError,
	type AuditResult,
	type BranchUpdate,
	type OverrideEntry,
	type Severity
} from './types'
import { compareSemver, getOverrideBranchPrefix, PR_FOOTER } from './utils'
// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = {
	info: 0,
	low: 1,
	moderate: 2,
	high: 3,
	critical: 4
} satisfies Record<Severity, number>

// ---------------------------------------------------------------------------
// Run audit
// ---------------------------------------------------------------------------

/**
 * Runs the provider's audit command and returns parsed results, or `None`
 * when the audit output could not be parsed. An empty (clean) result is
 * valid.
 *
 * Uses the silent Commands service rather than the logging wrapper because
 * audit tools return a non-zero exit code when vulnerabilities are found,
 * which is the expected (successful) case. A missing audit binary dies at
 * the Commands adapter — there is no output to interpret.
 */
export const runAudit = Effect.fn('Audit.runAudit')(function* ({
	cwd,
	audit
}: {
	cwd: string
	audit: AuditCapability
}) {
	const commands = yield* Commands
	const result = yield* commands.exec(audit.command, { cwd })

	const toolName = audit.command.at(0)
	const output = (result.stdout || result.stderr).trim()
	if (!output) {
		// Clean audits may legitimately print nothing (e.g. yarn NDJSON).
		return Option.some({})
	}

	const parsed = audit.parseOutput({ output })
	if (parsed === null) {
		yield* Effect.logWarning(
			`  ${toolName} audit returned unexpected output format`
		)
		return Option.none()
	}
	return Option.some(parsed)
})

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
	const strictBounds: Array<string> = []
	// Matches `<` followed immediately by a semver version (digit).
	// This naturally excludes `<=` since `=` is not a digit.
	const regex = /<(\d+\.\d+\.\d+(?:-[\w.]+)?)/g
	let m: RegExpExecArray | null

	while ((m = regex.exec(vulnerableVersions)) !== null) {
		const bound = m[1]
		if (bound !== undefined) {
			strictBounds.push(bound)
		}
	}

	if (strictBounds.length === 0) {
		return null
	}
	if (strictBounds.length === 1) {
		return strictBounds[0] ?? null
	}

	return strictBounds.reduce((highest, v) =>
		compareSemver({ a: v, b: highest }) > 0 ? v : highest
	)
}

// ---------------------------------------------------------------------------
// Compute overrides from audit results
// ---------------------------------------------------------------------------

/**
 * The desired override map: user-added overrides preserved, stale
 * tool-managed entries dropped, and one entry per (package, vulnerable
 * range) group pointing at the highest fixed version. Collisions (possible
 * when the provider keys overrides by package name alone) keep the highest
 * fixed version.
 */
export function computeOverrideMap({
	existing,
	overrides,
	audit
}: {
	existing: Record<string, string>
	overrides: Array<OverrideEntry>
	audit: AuditCapability
}) {
	const result: Record<string, string> = {}

	// Preserve user-added overrides (not tool-managed)
	for (const [key, value] of Object.entries(existing)) {
		if (!audit.isManagedOverride(key, value)) {
			result[key] = value
		}
	}

	// Add currently needed tool overrides
	for (const entry of overrides) {
		const key = audit.overrideKey(entry)
		const current = result[key]
		if (
			current === undefined ||
			compareSemver({ a: entry.fixedVersion, b: current }) > 0
		) {
			result[key] = entry.fixedVersion
		}
	}

	return result
}

export function computeOverrides({
	auditResult,
	catalogNames,
	minimumSeverity,
	existingOverrides,
	audit
}: {
	auditResult: AuditResult
	catalogNames: Set<string>
	minimumSeverity: Severity
	existingOverrides: Record<string, string>
	audit: AuditCapability
}): Array<OverrideEntry> {
	const minLevel = SEVERITY_ORDER[minimumSeverity]

	// Group by (packageName, vulnerable_versions) — each unique pair becomes one override entry
	const groupMap = new Map<string, OverrideEntry>()

	for (const [packageName, advisories] of Object.entries(auditResult)) {
		if (catalogNames.has(packageName)) {
			continue
		}

		for (const advisory of advisories) {
			if (SEVERITY_ORDER[advisory.severity] < minLevel) {
				continue
			}

			const fixed = parseFixedVersion({
				vulnerableVersions: advisory.vulnerable_versions
			})
			if (!fixed) {
				continue
			}

			const groupKey = audit.overrideKey({
				packageName,
				vulnerableRange: advisory.vulnerable_versions
			})
			const existing = groupMap.get(groupKey)

			if (existing) {
				// Keep the highest fixed version within the group
				groupMap.set(groupKey, {
					...existing,
					advisories: [...existing.advisories, advisory],
					fixedVersion:
						compareSemver({ a: fixed, b: existing.fixedVersion }) > 0
							? fixed
							: existing.fixedVersion
				})
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

	const entries: Array<OverrideEntry> = []

	for (const group of groupMap.values()) {
		const existingVersion = existingOverrides[audit.overrideKey(group)]
		if (
			existingVersion &&
			compareSemver({ a: existingVersion, b: group.fixedVersion }) >= 0
		) {
			// The override exists but the audit still reports the vulnerability —
			// the lockfile wasn't re-resolved after the override was added.
			// Include it so the PR branch can delete the lockfile and reinstall.
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
	overrides: Array<OverrideEntry>
}): string {
	const sorted = [...overrides].toSorted(
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
		lines.push(
			`<details>`,
			`<summary>${override.packageName} — ${override.advisories.length} advisory(ies)</summary>`,
			''
		)
		for (const advisory of override.advisories) {
			lines.push(
				`### ${advisory.title}`,
				`- **Severity**: ${advisory.severity}${advisory.cvss ? ` (CVSS ${advisory.cvss.score})` : ''}`,
				`- **Vulnerable versions**: \`${advisory.vulnerable_versions}\``
			)
			if (advisory.cwe && advisory.cwe.length > 0) {
				lines.push(`- **CWE**: ${advisory.cwe.join(', ')}`)
			}
			lines.push(`- **Advisory**: ${advisory.url}`, '')
		}
		lines.push('</details>', '')
	}

	lines.push(
		`> Override entries pin vulnerable transitive dependencies to patched versions.`,
		'',
		'---',
		PR_FOOTER
	)

	return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Build BranchUpdate for overrides
// ---------------------------------------------------------------------------

export function buildOverrideBranchUpdate({
	overrides,
	branchPrefix,
	titleSuffix = '',
	workDir,
	providerId
}: {
	overrides: Array<OverrideEntry>
	branchPrefix: string
	titleSuffix?: string
	workDir: string
	providerId: ProviderId
}): BranchUpdate {
	const n = overrides.length
	const title = `fix(security): override ${n} vulnerable transitive ${n === 1 ? 'dependency' : 'dependencies'}${titleSuffix}`
	const body = buildOverridePrBody({ overrides })
	const branch = `${getOverrideBranchPrefix({ branchPrefix })}/vulnerability-fixes`
	const provider = getProvider(providerId)
	const { audit } = provider
	const overridePath = `${workDir}/${audit.overrideFile}`
	const affectedFiles = [audit.overrideFile]

	return {
		branch,
		title,
		body,
		affectedFiles,
		expectedBasenames: expectedInstallBasenames({ provider, affectedFiles }),
		deleteLockfiles: [provider.lockfileName],
		installCommand: provider.installCommand,
		apply: Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const content = yield* fs.readFileString(overridePath).pipe(
				Effect.mapError(
					(cause) =>
						new BranchApplyError({
							operation: 'Audit.buildOverrideBranchUpdate.read',
							cause
						})
				)
			)
			const write = yield* Effect.try({
				try: () => {
					const existing = audit.readOverrides({ content }) ?? {}
					const map = computeOverrideMap({ existing, overrides, audit })
					return audit.writeOverrides({ content, map })
				},
				catch: (cause) =>
					new BranchApplyError({
						operation: 'Audit.buildOverrideBranchUpdate.writeOverrides',
						cause
					})
			})
			yield* fs.writeFileString(overridePath, write).pipe(
				Effect.mapError(
					(cause) =>
						new BranchApplyError({
							operation: 'Audit.buildOverrideBranchUpdate.write',
							cause
						})
				)
			)
		})
	}
}

// ---------------------------------------------------------------------------
// Check if override branch is outdated
// ---------------------------------------------------------------------------

export function isOverrideBranchOutdated({
	branchFiles,
	audit,
	expectedOverrides
}: {
	/** Content of each affected file on the branch (null when absent) */
	branchFiles: Map<string, string | null>
	audit: AuditCapability
	expectedOverrides: Array<OverrideEntry>
}): boolean {
	const content = branchFiles.get(audit.overrideFile)
	if (content === null || content === undefined) {
		return expectedOverrides.length > 0
	}

	const overrides = audit.readOverrides({ content })
	if (!overrides) {
		return expectedOverrides.length > 0
	}

	// Check all expected overrides are present with correct versions
	for (const entry of expectedOverrides) {
		if (overrides[audit.overrideKey(entry)] !== entry.fixedVersion) {
			return true
		}
	}

	// Check for stale tool-generated overrides that are no longer needed
	const expectedKeys = new Set(
		expectedOverrides.map((e) => audit.overrideKey(e))
	)
	for (const [key, value] of Object.entries(overrides)) {
		if (audit.isManagedOverride(key, value) && !expectedKeys.has(key)) {
			return true
		}
	}

	return false
}
