export type SemverChange = 'major' | 'minor' | 'patch' | 'prerelease' | 'release'

// ---------------------------------------------------------------------------
// Audit types
// ---------------------------------------------------------------------------

export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical'

export interface AuditAdvisory {
  id: number
  url: string
  title: string
  severity: Severity
  vulnerable_versions: string
  cwe: string[]
  cvss: { score: number; vectorString: string }
}

export type AuditResult = Record<string, AuditAdvisory[]>

export interface OverrideEntry {
  packageName: string
  vulnerableRange: string
  fixedVersion: string
  advisories: AuditAdvisory[]
}

// ---------------------------------------------------------------------------
// Directory context (for multi-directory / monorepo support)
// ---------------------------------------------------------------------------

export interface DirectoryContext {
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

export interface BranchUpdate {
  branch: string
  title: string
  body: string
  /** Mutates the given packageJson object in place to apply this update's changes. */
  applyChanges: (packageJson: Record<string, unknown>) => void
}

// ---------------------------------------------------------------------------
// Audit config
// ---------------------------------------------------------------------------

export interface AuditConfig {
  enabled: boolean
  minimumSeverity: Severity
}

export interface CatalogEntry {
  name: string
  /** The raw value from catalog (may include `npm:` alias or `^` prefix) */
  raw: string
  /** The actual npm package name to query (resolved from `npm:` aliases) */
  npmName: string
  /** Current version without range prefix */
  currentVersion: string
  /** Whether the raw value uses a `^` range prefix */
  hasCaret: boolean
  /** Whether this is an `npm:` alias (e.g., `npm:rolldown-vite@7.3.1`) */
  isAlias: boolean
  /** The alias package name if isAlias (e.g., `rolldown-vite`) */
  aliasName: string | null
}

export type UpdateCandidate = CatalogEntry & {
  latestVersion: string
  changeType: SemverChange
}

export interface GroupDefinition {
  name: string
  patterns: string[]
  updateTypes: SemverChange[] | null
}

export interface IgnoreRule {
  pattern: string
  updateTypes: SemverChange[] | null
}

export interface ExistingPr {
  headRefName: string
  number: number
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  title: string
}

export interface GitHubRepo {
  owner: string
  repo: string
}

export interface PackageMetadata {
  repo: GitHubRepo
  publishedVersions: string[]
  /** Mapping of version → ISO 8601 publish timestamp from npm registry */
  publishTimes: Record<string, string>
}

export interface VersionReleaseNote {
  version: string
  body: string
}

export interface Config {
  branchPrefix: string
  defaultBranch: string
  maxOpenPrs: number
  concurrency: number
  packageManager: 'bun' | 'npm' | 'pnpm' | 'yarn'
  minReleaseAgeDays: number
  groups: GroupDefinition[]
  ignore: IgnoreRule[]
  audit: AuditConfig
}
