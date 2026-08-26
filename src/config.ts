import { z } from 'zod'
import { severitySchema } from './schemas'
import {
	type AutoMergeConfig,
	type AuditConfig,
	type Config,
	type GroupDefinition,
	type IgnoreRule,
	type SemverChange
} from './types'

const DEFAULT_AUDIT_CONFIG: AuditConfig = {
	enabled: true,
	minimumSeverity: 'moderate'
}

const DEFAULT_AUTO_MERGE_CONFIG: AutoMergeConfig = {
	enabled: false,
	mergeMethod: 'squash'
}

const DEFAULT_CONFIG: Config = {
	branchPrefix: 'catalog-update',
	defaultBranch: 'master',
	maxOpenPrs: 20,
	concurrency: 10,
	packageManager: 'bun',
	minReleaseAgeDays: 0,
	groups: [],
	ignore: [],
	audit: DEFAULT_AUDIT_CONFIG,
	autoMerge: DEFAULT_AUTO_MERGE_CONFIG
}

const semverChangeSchema = z.enum([
	'major',
	'minor',
	'patch',
	'prerelease',
	'release'
])
const packageManagerSchema = z.enum(['bun', 'npm', 'pnpm', 'yarn'])
const mergeMethodSchema = z.enum(['squash', 'merge', 'rebase'])

/**
 * Parse an `updateTypes` value: null/undefined/non-array become null; an array
 * keeps only the members that are valid semver change types, collapsing to
 * null when none survive.
 */
function parseUpdateTypes({ raw }: { raw: unknown }): SemverChange[] | null {
	if (raw === null || raw === undefined) return null
	if (!Array.isArray(raw)) return null

	const valid = raw.filter(
		(item): item is SemverChange => semverChangeSchema.safeParse(item).success
	)
	return valid.length > 0 ? valid : null
}

/** Shared `updateTypes` field for group and ignore-rule schemas. */
const updateTypesField = z
	.unknown()
	.optional()
	.transform((raw) => parseUpdateTypes({ raw }))

const groupDefinitionSchema = z.object({
	name: z.string(),
	patterns: z
		.array(z.unknown())
		.transform((items) =>
			items.filter((item): item is string => z.string().safeParse(item).success)
		),
	updateTypes: updateTypesField
})

function parseGroups({ raw }: { raw: unknown }): GroupDefinition[] {
	if (!Array.isArray(raw)) return []

	return raw.flatMap((item) => {
		const parsed = groupDefinitionSchema.safeParse(item)
		return parsed.success ? [parsed.data] : []
	})
}

const auditConfigSchema = z.object({
	enabled: z.boolean().catch(DEFAULT_AUDIT_CONFIG.enabled),
	minimumSeverity: severitySchema.catch(DEFAULT_AUDIT_CONFIG.minimumSeverity)
})

export function parseAuditConfig({ raw }: { raw: unknown }): AuditConfig {
	const parsed = auditConfigSchema.safeParse(raw)
	return parsed.success ? parsed.data : DEFAULT_AUDIT_CONFIG
}

const autoMergeConfigSchema = z.object({
	enabled: z.boolean().catch(DEFAULT_AUTO_MERGE_CONFIG.enabled),
	mergeMethod: mergeMethodSchema.catch(DEFAULT_AUTO_MERGE_CONFIG.mergeMethod)
})

export function parseAutoMergeConfig({
	raw
}: {
	raw: unknown
}): AutoMergeConfig {
	const parsed = autoMergeConfigSchema.safeParse(raw)
	return parsed.success ? parsed.data : DEFAULT_AUTO_MERGE_CONFIG
}

const ignoreRuleSchema = z.object({
	pattern: z.string(),
	updateTypes: updateTypesField
})

function parseIgnoreRules({ raw }: { raw: unknown }): IgnoreRule[] {
	if (!Array.isArray(raw)) return []

	return raw.flatMap((item) => {
		const parsed = ignoreRuleSchema.safeParse(item)
		return parsed.success ? [parsed.data] : []
	})
}

const configSchema = z.object({
	branchPrefix: z.string().catch(DEFAULT_CONFIG.branchPrefix),
	defaultBranch: z.string().catch(DEFAULT_CONFIG.defaultBranch),
	maxOpenPrs: z.number().catch(DEFAULT_CONFIG.maxOpenPrs),
	concurrency: z.number().catch(DEFAULT_CONFIG.concurrency),
	packageManager: packageManagerSchema.catch(DEFAULT_CONFIG.packageManager),
	minReleaseAgeDays: z
		.number()
		.int()
		.nonnegative()
		.catch(DEFAULT_CONFIG.minReleaseAgeDays),
	groups: z
		.unknown()
		.optional()
		.transform((raw) => parseGroups({ raw })),
	ignore: z
		.unknown()
		.optional()
		.transform((raw) => parseIgnoreRules({ raw })),
	audit: auditConfigSchema.catch(DEFAULT_AUDIT_CONFIG),
	autoMerge: autoMergeConfigSchema.catch(DEFAULT_AUTO_MERGE_CONFIG)
})

export async function loadConfig({
	configPath
}: {
	configPath: string
}): Promise<Config> {
	try {
		const file = Bun.file(configPath)
		const exists = await file.exists()

		if (!exists) {
			console.warn(`Config file not found at ${configPath}, using defaults`)
			return DEFAULT_CONFIG
		}

		const parsed = await file.json()
		const result = configSchema.safeParse(parsed)
		if (!result.success) {
			console.warn(
				`Config file at ${configPath} is not a JSON object, using defaults`
			)
			return DEFAULT_CONFIG
		}
		const config = result.data

		// Unattended merges plus a zero-day-old release means a compromised
		// version can reach the default branch before anyone reads the diff.
		if (config.autoMerge.enabled && config.minReleaseAgeDays === 0) {
			console.warn(
				'Warning: autoMerge is enabled with minReleaseAgeDays: 0. Freshly published versions will merge without review. Set minReleaseAgeDays to quarantine new releases.'
			)
		}

		return config
	} catch (error) {
		console.error(`Failed to load config from ${configPath}:`, error)
		return DEFAULT_CONFIG
	}
}
