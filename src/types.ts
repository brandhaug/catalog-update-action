export type SemverChange = 'major' | 'minor' | 'patch'

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
  groups: GroupDefinition[]
  ignore: IgnoreRule[]
}
