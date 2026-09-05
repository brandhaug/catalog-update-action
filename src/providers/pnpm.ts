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
// pnpm <= 10 emits cwe as the npm 6 array; pnpm 11 collapses it to a bare
// string — ArrayEnsure accepts either and normalizes to the array.
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
	cwe: Schema.optionalKey(Schema.ArrayEnsure(Schema.String))
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
	const result = Schema.decodeUnknownOption(pnpmAuditOutputSchema)(parsed.value)
	if (Option.isNone(result)) {
		return null
	}

	// The npm-6-style output is keyed by advisory id; regroup by module name.
	// The id may arrive as a string, and cwe/cvss are optional — the only
	// field-level normalization any provider actually needs.
	const auditResult: AuditResult = {}
	for (const advisory of Object.values(result.value.advisories)) {
		auditResult[advisory.module_name] = [
			...(auditResult[advisory.module_name] ?? []),
			{
				id: Number(advisory.id),
				url: advisory.url,
				title: advisory.title,
				severity: advisory.severity,
				vulnerable_versions: advisory.vulnerable_versions,
				cwe: advisory.cwe,
				cvss: advisory.cvss
			}
		]
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
	// CI runners set CI=true, which makes pnpm default to --frozen-lockfile;
	// the catalog edits this action has already written to
	// pnpm-workspace.yaml would then fail with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
	installCommand: ['pnpm', 'install', '--no-frozen-lockfile'],
	lockfileName: 'pnpm-lock.yaml',
	// pnpm may rewrite pnpm-workspace.yaml (e.g. when overrides change).
	installArtifacts: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'],
	audit: pnpmAudit,
	parseDefinitions: parseYamlCatalogs,
	applyUpdates: applyYamlCatalogUpdates
}
