import { Effect, FileSystem, Option, Schema } from 'effect'

import {
	mergeMethodSchema,
	parseJsonDocument,
	readJsonObject,
	semverChangeSchema,
	severitySchema,
	type JsonValue
} from './schemas'
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
	minReleaseAgeDays: 0,
	groups: [],
	ignore: [],
	audit: DEFAULT_AUDIT_CONFIG,
	autoMerge: DEFAULT_AUTO_MERGE_CONFIG
}

/** Whole, non-negative number of days. */
const nonNegativeIntSchema = Schema.Number.check(
	Schema.isInt(),
	Schema.isGreaterThanOrEqualTo(0)
)

/**
 * Decode a single JSON field, falling back to a default when the key is
 * absent or its value does not match the schema. This mirrors the previous
 * zod `.catch()` semantics: one bad field never invalidates the rest of the
 * config.
 */
function field<
	S extends Schema.Constraint & { readonly DecodingServices: never }
>(schema: S, raw: JsonValue | undefined, fallback: S['Type']): S['Type'] {
	if (raw === undefined || raw === null) {
		return fallback
	}
	return Option.getOrElse(
		Schema.decodeUnknownOption(schema)(raw),
		() => fallback
	)
}

/**
 * Parse an `updateTypes` value: null/undefined/non-array become null; an array
 * keeps only the members that are valid semver change types, collapsing to
 * null when none survive.
 */
function parseUpdateTypesField({
	raw
}: {
	raw: JsonValue | undefined
}): Array<SemverChange> | null {
	if (!Array.isArray(raw)) {
		return null
	}

	const valid = raw.flatMap((item) => {
		const decoded = Schema.decodeUnknownOption(semverChangeSchema)(item)
		return Option.isSome(decoded) ? [decoded.value] : []
	})
	return valid.length > 0 ? valid : null
}

/** Keep only the string members of a raw JSON array. */
function parseStringArray(raw: JsonValue | undefined): Array<string> {
	if (!Array.isArray(raw)) {
		return []
	}
	return raw.flatMap((item) => {
		const decoded = Schema.decodeUnknownOption(Schema.String)(item)
		return Option.isSome(decoded) ? [decoded.value] : []
	})
}

/**
 * Parse the `groups` field: entries need a string `name`; malformed entries
 * are dropped rather than rejecting the whole config.
 */
function parseGroups({
	raw
}: {
	raw: JsonValue | undefined
}): Array<GroupDefinition> {
	if (!Array.isArray(raw)) {
		return []
	}

	return raw.flatMap((item) => {
		const object = readJsonObject(item)
		if (!object) {
			return []
		}
		const name = Schema.decodeUnknownOption(Schema.String)(object.name)
		// `patterns` is required: an entry without it is malformed, not
		// merely empty (matching the previous zod schema).
		if (Option.isNone(name) || !Array.isArray(object.patterns)) {
			return []
		}
		return [
			{
				name: name.value,
				patterns: parseStringArray(object.patterns),
				updateTypes: parseUpdateTypesField({ raw: object.updateTypes })
			}
		]
	})
}

/**
 * Parse the `ignore` field: entries need a string `pattern`; malformed
 * entries are dropped rather than rejecting the whole config.
 */
function parseIgnoreRules({
	raw
}: {
	raw: JsonValue | undefined
}): Array<IgnoreRule> {
	if (!Array.isArray(raw)) {
		return []
	}

	return raw.flatMap((item) => {
		const object = readJsonObject(item)
		if (!object) {
			return []
		}
		const pattern = Schema.decodeUnknownOption(Schema.String)(object.pattern)
		if (Option.isNone(pattern)) {
			return []
		}
		return [
			{
				pattern: pattern.value,
				updateTypes: parseUpdateTypesField({ raw: object.updateTypes })
			}
		]
	})
}

export function parseAuditConfig({ raw }: { raw: unknown }): AuditConfig {
	const object = readJsonObject(raw) ?? {}
	return {
		enabled: field(
			Schema.Boolean,
			object.enabled,
			DEFAULT_AUDIT_CONFIG.enabled
		),
		minimumSeverity: field(
			severitySchema,
			object.minimumSeverity,
			DEFAULT_AUDIT_CONFIG.minimumSeverity
		)
	}
}

export function parseAutoMergeConfig({
	raw
}: {
	raw: unknown
}): AutoMergeConfig {
	const object = readJsonObject(raw) ?? {}
	return {
		enabled: field(
			Schema.Boolean,
			object.enabled,
			DEFAULT_AUTO_MERGE_CONFIG.enabled
		),
		mergeMethod: field(
			mergeMethodSchema,
			object.mergeMethod,
			DEFAULT_AUTO_MERGE_CONFIG.mergeMethod
		)
	}
}

/**
 * Load and decode `.catalog-updaterc.json`.
 *
 * The loader never fails: a missing file, malformed JSON or invalid fields
 * fall back to defaults with a warning, so a broken config can never take a
 * dependency-update run down.
 */
export const loadConfig = Effect.fn('Config.loadConfig')(function* ({
	configPath
}: {
	configPath: string
}) {
	const fs = yield* FileSystem.FileSystem

	const exists = yield* fs.exists(configPath).pipe(
		// An unreadable path is equivalent to "no config here": fall back to
		// defaults instead of failing the run.
		Effect.catch(() => Effect.succeed(false))
	)
	if (!exists) {
		yield* Effect.logWarning(
			`Config file not found at ${configPath}, using defaults`
		)
		return DEFAULT_CONFIG
	}

	const content = yield* fs.readFileString(configPath).pipe(Effect.option)
	if (Option.isNone(content)) {
		yield* Effect.logError(`Failed to load config from ${configPath}`)
		return DEFAULT_CONFIG
	}

	const parsed = parseJsonDocument(content.value)
	if (Option.isNone(parsed)) {
		yield* Effect.logError(`Failed to load config from ${configPath}`)
		return DEFAULT_CONFIG
	}

	const object = readJsonObject(parsed.value)
	if (!object) {
		yield* Effect.logWarning(
			`Config file at ${configPath} is not a JSON object, using defaults`
		)
		return DEFAULT_CONFIG
	}

	// The manager is now detected from the catalog definition files, so this
	// legacy option is meaningless — warn rather than silently drop.
	if ('packageManager' in object) {
		yield* Effect.logWarning(
			'Warning: "packageManager" config is no longer used. The package manager is detected from your catalog definition files (package.json / pnpm-workspace.yaml / .yarnrc.yml).'
		)
	}

	const config: Config = {
		branchPrefix: field(
			Schema.String,
			object.branchPrefix,
			DEFAULT_CONFIG.branchPrefix
		),
		defaultBranch: field(
			Schema.String,
			object.defaultBranch,
			DEFAULT_CONFIG.defaultBranch
		),
		maxOpenPrs: field(
			Schema.Number,
			object.maxOpenPrs,
			DEFAULT_CONFIG.maxOpenPrs
		),
		concurrency: field(
			Schema.Number,
			object.concurrency,
			DEFAULT_CONFIG.concurrency
		),
		minReleaseAgeDays: field(
			nonNegativeIntSchema,
			object.minReleaseAgeDays,
			DEFAULT_CONFIG.minReleaseAgeDays
		),
		groups: parseGroups({ raw: object.groups }),
		ignore: parseIgnoreRules({ raw: object.ignore }),
		audit: parseAuditConfig({ raw: object.audit }),
		autoMerge: parseAutoMergeConfig({ raw: object.autoMerge })
	}

	// Unattended merges plus a zero-day-old release means a compromised
	// version can reach the default branch before anyone reads the diff.
	if (config.autoMerge.enabled && config.minReleaseAgeDays === 0) {
		yield* Effect.logWarning(
			'Warning: autoMerge is enabled with minReleaseAgeDays: 0. Freshly published versions will merge without review. Set minReleaseAgeDays to quarantine new releases.'
		)
	}

	return config
})
