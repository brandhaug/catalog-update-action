import { z } from 'zod'
import { severitySchema } from '../schemas'
import { isToolOverrideKey, overrideKey } from '../utils'
import { type AuditResult } from '../types'
import { type AuditCapability, type CatalogProvider } from './types'
import {
	applyYamlCatalogUpdates,
	parseYamlCatalogs,
	readYamlTopLevelMap,
	writeYamlTopLevelMap
} from './yaml'

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

// pnpm `audit --json` emits the npm 6 style: one map of advisories keyed by
// advisory id, each carrying the fields we need for override computation.
const pnpmAdvisorySchema = z.object({
	id: z.union([z.number(), z.string()]),
	module_name: z.string(),
	severity: severitySchema,
	vulnerable_versions: z.string(),
	title: z.string(),
	url: z.string(),
	cvss: z.object({ score: z.number(), vectorString: z.string() }).optional(),
	cwe: z.array(z.string()).optional()
})

const pnpmAuditOutputSchema = z.object({
	advisories: z.record(z.string(), pnpmAdvisorySchema)
})

function parsePnpmAuditOutput({
	output
}: {
	output: string
}): AuditResult | null {
	let data: unknown
	try {
		data = JSON.parse(output)
	} catch {
		return null
	}
	const parsed = pnpmAuditOutputSchema.safeParse(data)
	if (!parsed.success) {
		return null
	}

	const result: AuditResult = {}
	for (const advisory of Object.values(parsed.data.advisories)) {
		const advisories = result[advisory.module_name] ?? []
		advisories.push({
			id: Number(advisory.id),
			url: advisory.url,
			title: advisory.title,
			severity: advisory.severity,
			vulnerable_versions: advisory.vulnerable_versions,
			cwe: advisory.cwe,
			cvss: advisory.cvss
		})
		result[advisory.module_name] = advisories
	}
	return result
}

const pnpmAudit: AuditCapability = {
	command: ['pnpm', 'audit', '--json'],
	parseOutput: parsePnpmAuditOutput,
	overrideFile: 'pnpm-workspace.yaml',
	overrideField: 'overrides',
	// pnpm overrides support `pkg@<range>` selector keys, same as bun.
	overrideKey,
	isManagedOverride: (key) => isToolOverrideKey(key),
	readOverrides: ({ content }) =>
		readYamlTopLevelMap({ content, field: 'overrides' }),
	writeOverrides: ({ content, map }) =>
		writeYamlTopLevelMap({ content, field: 'overrides', map })
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const pnpmProvider: CatalogProvider = {
	id: 'pnpm',
	installCommand: ['pnpm', 'install'],
	lockfileName: 'pnpm-lock.yaml',
	// pnpm may rewrite pnpm-workspace.yaml (e.g. when overrides change).
	installArtifacts: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'],
	audit: pnpmAudit,
	parseDefinitions: parseYamlCatalogs,
	applyUpdates: applyYamlCatalogUpdates
}
