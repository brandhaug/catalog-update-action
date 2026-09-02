import { Option, Schema } from 'effect'
import { severitySchema } from '../schemas'
import { parseSemver } from '../utils'
import { type AuditResult, type Severity } from '../types'
import { type AuditCapability, type CatalogProvider } from './types'
import { readJsonStringMap, writeJsonStringMap } from './json'
import { applyYamlCatalogUpdates, parseYamlCatalogs } from './yaml'

// ---------------------------------------------------------------------------
// Audit output parsing
// ---------------------------------------------------------------------------

// `yarn npm audit --json` emits NDJSON: one advisory per line, with the
// human-readable field names berry uses for its table output.
const yarnAuditLineSchema = Schema.Struct({
	value: Schema.String,
	children: Schema.Struct({
		ID: Schema.Union([Schema.Number, Schema.String]),
		Issue: Schema.String,
		URL: Schema.String,
		Severity: Schema.String,
		'Vulnerable Versions': Schema.String
	})
})

/** Decode an audit severity: case-insensitive member of the severity set. */
function parseSeverity({ raw }: { raw: string }): Option.Option<Severity> {
	return Schema.decodeUnknownOption(severitySchema)(raw.toLowerCase())
}

function parseYarnAuditOutput({
	output
}: {
	output: string
}): AuditResult | null {
	const lines = output
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
	if (lines.length === 0) {
		return {}
	}

	const result: AuditResult = {}
	let parsedCount = 0
	for (const line of lines) {
		const raw = parseJsonLine(line)
		if (Option.isNone(raw)) {
			continue
		}
		const parsed = Schema.decodeUnknownResult(yarnAuditLineSchema)(raw.value)
		if (parsed._tag === 'Failure') {
			continue
		}
		const severity = parseSeverity({ raw: parsed.success.children.Severity })
		if (Option.isNone(severity)) {
			continue
		}
		parsedCount++
		const advisory = parsed.success
		const advisories = result[advisory.value] ?? []
		advisories.push({
			id: Number(advisory.children.ID),
			url: advisory.children.URL,
			title: advisory.children.Issue,
			severity: severity.value,
			vulnerable_versions: advisory.children['Vulnerable Versions']
		})
		result[advisory.value] = advisories
	}

	// Lines existed but none matched the expected shape — treat the whole
	// output as unparseable rather than reporting a false "clean" result.
	if (lines.length > 0 && parsedCount === 0) {
		return null
	}
	return result
}

/** Parse one NDJSON line, returning None for malformed JSON. */
const parseJsonLine = (input: string): Option.Option<unknown> =>
	Option.liftThrowable(JSON.parse)(input)

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

const yarnAudit: AuditCapability = {
	command: ['yarn', 'npm', 'audit', '--json', '--all', '--recursive'],
	parseOutput: parseYarnAuditOutput,
	overrideFile: 'package.json',
	overrideField: 'resolutions',
	// Yarn resolutions only apply plain-name keys (range selectors are
	// ignored), so overrides are keyed by package name and multiple advisory
	// ranges for one package collapse into the highest fixed version.
	overrideKey: (entry) => entry.packageName,
	// Key ownership cannot be derived from plain names, so entries are
	// considered tool-managed when the pinned value is an exact semver
	// version — the format this tool writes. User resolutions using ranges
	// are always preserved.
	isManagedOverride: (_key, value) => parseSemver({ version: value }) !== null,
	readOverrides: ({ content }) =>
		readJsonStringMap({ content, field: 'resolutions' }),
	writeOverrides: ({ content, map }) =>
		writeJsonStringMap({ content, field: 'resolutions', map })
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const yarnProvider: CatalogProvider = {
	id: 'yarn',
	installCommand: ['yarn', 'install'],
	lockfileName: 'yarn.lock',
	// yarn install may update .yarnrc.yml settings alongside the lockfile.
	installArtifacts: ['yarn.lock', '.yarnrc.yml'],
	audit: yarnAudit,
	parseDefinitions: parseYamlCatalogs,
	applyUpdates: applyYamlCatalogUpdates
}
