import {
	type AuditResult,
	type OverrideEntry,
	type UpdateCandidate
} from '../types'

export type ProviderId = 'bun' | 'pnpm' | 'yarn'

/**
 * A catalog definition parsed out of a definition file. `catalogName` is
 * `'default'` for the singular `catalog` field; anything else references a
 * named catalog (`catalog:<name>` in workspace manifests).
 */
export type ParsedCatalog = {
	catalogName: string
	entries: Record<string, string>
}

/**
 * Everything the pipeline needs to run `audit` and manage transitive
 * vulnerability overrides for one package manager.
 */
export type AuditCapability = {
	/** Command producing audit JSON output (may exit non-zero on findings). */
	command: Array<string>
	/** Parse audit output into results keyed by package name. */
	parseOutput(input: { output: string }): AuditResult | null
	/** Repo-relative file whose field carries the override map. */
	overrideFile: string
	/** Field/key of overrideFile holding the override map. */
	overrideField: string
	/** Key this tool writes for an override entry (unique per package+range). */
	overrideKey(
		entry: Pick<OverrideEntry, 'packageName' | 'vulnerableRange'>
	): string
	/** Whether an existing override entry was written by this tool. */
	isManagedOverride(key: string, value: string): boolean
	/** Extract the override map from overrideFile content. */
	readOverrides(input: { content: string }): Record<string, string> | undefined
	/** Rewrite overrideFile content with the given override map. */
	writeOverrides(input: {
		content: string
		map: Record<string, string>
	}): string
}

/**
 * Everything the pipeline needs to know about a package manager's catalog
 * format. All content functions are pure (string in, string out) so they can
 * be unit tested without touching the filesystem.
 */
export type CatalogProvider = {
	id: ProviderId
	/** Command run after applying updates, to refresh the lockfile. */
	installCommand: Array<string>
	/** Lockfile basename (workDir-relative), deleted to force re-resolution. */
	lockfileName: string
	/** Audit + override support; undefined when the provider cannot audit. */
	audit?: AuditCapability
	/** Extract every catalog definition from a definition file's content. */
	parseDefinitions(input: { content: string }): Array<ParsedCatalog>
	/** Apply catalog updates to a definition file's content. */
	applyUpdates(input: {
		content: string
		catalogName: string
		updates: Array<UpdateCandidate>
	}): string
}
