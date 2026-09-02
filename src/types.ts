import { Schema, type Effect, type FileSystem } from 'effect'
import { type ParsedCatalog, type ProviderId } from './providers'
import {
	type MergeableState,
	type MergeMethod,
	type SemverChange,
	type Severity
} from './schemas'
export type {
	MergeableState,
	MergeMethod,
	SemverChange,
	Severity
} from './schemas'

// ---------------------------------------------------------------------------
// Audit types
// ---------------------------------------------------------------------------

export type AuditAdvisory = {
	id: number
	url: string
	title: string
	severity: Severity
	vulnerable_versions: string
	/** Not reported by every audit tool (e.g. Yarn omits it). */
	cwe?: ReadonlyArray<string>
	cvss?: { readonly score: number; readonly vectorString: string }
}

export type AuditResult = Record<string, ReadonlyArray<AuditAdvisory>>

export type OverrideEntry = {
	packageName: string
	vulnerableRange: string
	fixedVersion: string
	advisories: ReadonlyArray<AuditAdvisory>
	/** True when an override already exists in package.json but bun audit still reports the vulnerability (stale lockfile). */
	existingOverrideStale?: boolean
}

// ---------------------------------------------------------------------------
// Catalog locations (for multi-directory / multi-manager / monorepo support)
// ---------------------------------------------------------------------------

/** A catalog definition found somewhere in the repository. */
export type CatalogLocation = {
	/** Repo-relative directory containing the definition (`'.'` for the root) */
	dir: string
	/** Package manager that owns the catalog format */
	providerId: ProviderId
	/** Repo-relative path of the file defining the catalog */
	definitionRelPath: string
	/** The parsed definition this location points at */
	definition: ParsedCatalog
}

export type DirectoryContext = {
	/** Repo root (absolute path, used for git operations) */
	cwd: string
	/** Project directory (absolute path, used for install/audit) */
	workDir: string
}

// ---------------------------------------------------------------------------
// Generic PR abstraction
// ---------------------------------------------------------------------------

/** Failure produced while writing an update into the working tree. */
// Schema.TaggedError declarations are class declarations, not throw sites;
// unicorn/throw-new-error misreads the TaggedError() constructor call as an
// un-newed throw.
// oxlint-disable-next-line unicorn/throw-new-error
export class BranchApplyError extends Schema.TaggedError<BranchApplyError>()(
	'BranchApplyError',
	{
		operation: Schema.String,
		cause: Schema.Defect()
	}
) {}

export type BranchUpdate = {
	branch: string
	title: string
	body: string
	/** Repo-relative files this update touches (staged after install, read for drift checks) */
	affectedFiles: Array<string>
	/**
	 * Basenames that may legitimately change during install: the affected
	 * files plus the provider's own artifacts. Used to warn about unexpected
	 * install writes.
	 */
	expectedBasenames: Array<string>
	/** Writes the update into the checked-out working tree. */
	apply: Effect.Effect<void, BranchApplyError, FileSystem.FileSystem>
	/**
	 * Lockfiles (workDir-relative) to delete before running install, forcing
	 * full re-resolution. Needed for override branches because range-based
	 * overrides are ignored for already-locked packages.
	 */
	deleteLockfiles?: Array<string>
	/** Install command refreshing the lockfile after applying the update. */
	installCommand: Array<string>
}

/**
 * The sync decision for one existing PR: the update the branch should carry,
 * and how to tell whether the branch's checked-out content has drifted from
 * it. One callback returning the pair, so callers compute the group context
 * once instead of re-deriving it from branch-name strings.
 */
export type PrSyncPlan = {
	branchUpdate: BranchUpdate
	isOutdated(input: {
		/** Content of each affected file on the branch (null when absent) */
		branchFiles: Map<string, string | null>
	}): boolean
}

// ---------------------------------------------------------------------------
// Audit config
// ---------------------------------------------------------------------------

export type AuditConfig = {
	enabled: boolean
	minimumSeverity: Severity
}

export type CatalogEntry = {
	name: string
	/** The actual npm package name to query (resolved from `npm:` aliases) */
	npmName: string
	/** Current version without range prefix */
	currentVersion: string
	/** Range prefix from the raw value (`^`, `~`, or empty string for pinned) */
	rangePrefix: '^' | '~' | ''
	/** Whether this is an `npm:` alias (e.g., `npm:rolldown-vite@7.3.1`) */
	isAlias: boolean
}

export type UpdateCandidate = CatalogEntry & {
	latestVersion: string
	changeType: SemverChange
}

export type GroupDefinition = {
	name: string
	patterns: Array<string>
	updateTypes: Array<SemverChange> | null
}

export type IgnoreRule = {
	pattern: string
	updateTypes: Array<SemverChange> | null
}

export type ExistingPr = {
	headRefName: string
	number: number
	mergeable: MergeableState
	title: string
}

export type GitHubRepo = {
	owner: string
	repo: string
}

export type PackageMetadata = {
	repo: GitHubRepo | null
	publishedVersions: Array<string>
	/** Mapping of version → ISO 8601 publish timestamp from npm registry */
	publishTimes: Record<string, string>
}

export type VersionReleaseNote = {
	version: string
	body: string
}

export type AutoMergeConfig = {
	enabled: boolean
	mergeMethod: MergeMethod
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type Config = {
	branchPrefix: string
	defaultBranch: string
	maxOpenPrs: number
	concurrency: number
	minReleaseAgeDays: number
	groups: Array<GroupDefinition>
	ignore: Array<IgnoreRule>
	audit: AuditConfig
	autoMerge: AutoMergeConfig
}
