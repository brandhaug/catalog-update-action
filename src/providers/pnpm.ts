import { Option, Schema } from 'effect'
import { parseJsonDocument, severitySchema } from '../schemas'
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
const pnpmAdvisorySchema = Schema.Struct({
	id: Schema.Union([Schema.Number, Schema.String]),
	module_name: Schema.String,
	severity: severitySchema,
	vulnerable_versions: Schema.String,
	title: Schema.String,
	url: Schema.String,
	cvss: Schema.optionalKey(
		Schema.Struct({ score: Schema.Number, vectorString: Schema.String })
	),
	cwe: Schema.optionalKey(Schema.Array(Schema.String))
})

const pnpmAuditOutputSchema = Schema.Struct({
	advisories: Schema.Record(Schema.String, pnpmAdvisorySchema)
})

function parsePnpmAuditOutput({
	output
}: {
	output: string
}): AuditResult | null {
	const parsed = parseJsonDocument(output)
	if (Option.isNone(parsed)) {
		return null
	}
	const result = Schema.decodeUnknownResult(pnpmAuditOutputSchema)(parsed.value)
	if (result._tag === 'Failure') {
		return null
	}

	const auditResult: AuditResult = {}
	for (const advisory of Object.values(result.success.advisories)) {
		const advisories = auditResult[advisory.module_name] ?? []
		advisories.push({
			id: Number(advisory.id),
			url: advisory.url,
			title: advisory.title,
			severity: advisory.severity,
			vulnerable_versions: advisory.vulnerable_versions,
			cwe: advisory.cwe === undefined ? undefined : [...advisory.cwe],
			cvss: advisory.cvss === undefined ? undefined : { ...advisory.cvss }
		})
		auditResult[advisory.module_name] = advisories
	}
	return auditResult
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
