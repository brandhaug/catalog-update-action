import { type PackageJson, type Severity } from './schemas'
export type { Severity } from './schemas'

export type SemverChange =
	| 'major'
	| 'minor'
	| 'patch'
	| 'prerelease'
	| 'release'

// ---------------------------------------------------------------------------
// Audit types
// ---------------------------------------------------------------------------

export type AuditAdvisory = {
	id: number
	url: string
	title: string
	severity: Severity
	vulnerable_versions: string
	cwe: string[]
	cvss: { score: number; vectorString: string }
}

export type AuditResult = Record<string, AuditAdvisory[]>

export type OverrideEntry = {
	packageName: string
	vulnerableRange: string
	fixedVersion: string
	advisories: AuditAdvisory[]
	/** True when an override already exists in package.json but bun audit still reports the vulnerability (stale lockfile). */
	existingOverrideStale?: boolean
}

// ---------------------------------------------------------------------------
// Directory context (for multi-directory / monorepo support)
// ---------------------------------------------------------------------------

export type DirectoryContext = {
	/** Repo root (absolute path, used for git operations) */
	cwd: string
	/** Project directory (absolute path, used for install/audit) */
	workDir: string
	/** Absolute path to package.json */
	packageJsonPath: string
	/** Repo-relative path to package.json (for git show / git add) */
	packageJsonRelPath: string
}

// ---------------------------------------------------------------------------
// Generic PR abstraction
// ---------------------------------------------------------------------------

export type BranchUpdate = {
	branch: string
	title: string
	body: string
	/** Mutates the given packageJson object in place to apply this update's changes. */
	applyChanges: (packageJson: PackageJson) => void
	/**
	 * When true, delete the lockfile before running install to force full
	 * re-resolution.  Needed for override branches because bun's `@range`
	 * override syntax is ignored for already-locked packages.
	 */
	deleteLockfile?: boolean
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
	patterns: string[]
	updateTypes: SemverChange[] | null
}

export type IgnoreRule = {
	pattern: string
	updateTypes: SemverChange[] | null
}

export type ExistingPr = {
	headRefName: string
	number: number
	mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
	title: string
}

export type GitHubRepo = {
	owner: string
	repo: string
}

export type PackageMetadata = {
	repo: GitHubRepo | null
	publishedVersions: string[]
	/** Mapping of version → ISO 8601 publish timestamp from npm registry */
	publishTimes: Record<string, string>
}

export type VersionReleaseNote = {
	version: string
	body: string
}

export type MergeMethod = 'squash' | 'merge' | 'rebase'

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
	packageManager: 'bun' | 'npm' | 'pnpm' | 'yarn'
	minReleaseAgeDays: number
	groups: GroupDefinition[]
	ignore: IgnoreRule[]
	audit: AuditConfig
	autoMerge: AutoMergeConfig
}
