import type {
  CatalogEntry,
  GitHubRepo,
  PackageMetadata,
  UpdateCandidate,
  VersionReleaseNote
} from './types'
import { extractVersionFromTag, getIntermediateVersions, Semaphore } from './utils'

const RELEASE_NOTES_MAX_LENGTH = 2000
const COMBINED_RELEASE_NOTES_MAX_LENGTH = 5000

// ---------------------------------------------------------------------------
// npm registry
// ---------------------------------------------------------------------------

/** Query the npm registry for latest stable versions of each catalog entry. */
export async function queryNpmRegistry({
  entries,
  semaphore
}: {
  entries: CatalogEntry[]
  semaphore: Semaphore
}): Promise<Map<string, string>> {
  const results = new Map<string, string>()

  const tasks = entries.map(async (entry) => {
    await semaphore.acquire()
    try {
      const encodedName = entry.npmName.replace('/', '%2f')
      const response = await fetch(`https://registry.npmjs.org/${encodedName}`, {
        headers: { Accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(15_000)
      })

      if (!response.ok) {
        console.warn(`  Warning: Failed to fetch ${entry.npmName} (${response.status})`)
        return
      }

      const data = (await response.json()) as { 'dist-tags'?: { latest?: string } }
      const latest = data['dist-tags']?.latest
      if (latest && !latest.includes('-')) {
        results.set(entry.name, latest)
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
      console.warn(`  Warning: Error fetching ${entry.npmName}: ${message}`)
    } finally {
      semaphore.release()
    }
  })

  await Promise.all(tasks)
  return results
}

// ---------------------------------------------------------------------------
// Package metadata (GitHub repo URLs + published versions)
// ---------------------------------------------------------------------------

function parseGitHubRepo({ url }: { url: string }): GitHubRepo | null {
  const match = url.match(/github\.com[/:]([w.-]+)\/([w.-]+?)(?:\.git)?$/)
  if (!match?.[1] || !match[2]) return null
  return { owner: match[1], repo: match[2] }
}

export async function queryPackageMetadata({
  candidates,
  semaphore
}: {
  candidates: UpdateCandidate[]
  semaphore: Semaphore
}): Promise<Map<string, PackageMetadata>> {
  const results = new Map<string, PackageMetadata>()
  const seen = new Map<string, PackageMetadata>()

  const tasks = candidates.map(async (candidate) => {
    const cached = seen.get(candidate.npmName)
    if (cached) {
      results.set(candidate.name, cached)
      return
    }

    await semaphore.acquire()
    try {
      const encodedName = candidate.npmName.replace('/', '%2f')
      const response = await fetch(`https://registry.npmjs.org/${encodedName}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000)
      })

      if (!response.ok) return

      const data = (await response.json()) as {
        repository?: { url?: string }
        versions?: Record<string, unknown>
      }
      const repoUrl = data.repository?.url
      if (!repoUrl) return

      const repo = parseGitHubRepo({ url: repoUrl })
      if (!repo) return

      const publishedVersions = data.versions ? Object.keys(data.versions) : []
      const metadata: PackageMetadata = { repo, publishedVersions }

      seen.set(candidate.npmName, metadata)
      results.set(candidate.name, metadata)
    } catch {
      // Non-critical — skip silently
    } finally {
      semaphore.release()
    }
  })

  await Promise.all(tasks)
  return results
}

// ---------------------------------------------------------------------------
// GitHub release notes
// ---------------------------------------------------------------------------

export async function queryReleaseNotes({
  candidates,
  packageMetadata,
  semaphore
}: {
  candidates: UpdateCandidate[]
  packageMetadata: Map<string, PackageMetadata>
  semaphore: Semaphore
}): Promise<Map<string, VersionReleaseNote[]>> {
  const results = new Map<string, VersionReleaseNote[]>()
  const githubToken = process.env.GITHUB_TOKEN
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`
  }

  const repoKey = (repo: GitHubRepo): string => `${repo.owner}/${repo.repo}`
  const repoToCandidates = new Map<string, { repo: GitHubRepo; candidates: UpdateCandidate[] }>()

  for (const candidate of candidates) {
    const metadata = packageMetadata.get(candidate.name)
    if (!metadata) continue
    const key = repoKey(metadata.repo)
    const existing = repoToCandidates.get(key)
    if (existing) {
      existing.candidates.push(candidate)
    } else {
      repoToCandidates.set(key, { repo: metadata.repo, candidates: [candidate] })
    }
  }

  const tasks = [...repoToCandidates.values()].map(async ({ repo, candidates: repoCandidates }) => {
    await semaphore.acquire()
    try {
      const response = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=100`,
        { headers, signal: AbortSignal.timeout(15_000) }
      )
      if (!response.ok) return

      const releases = (await response.json()) as Array<{ tag_name: string; body?: string; html_url?: string }>

      const genericReleases = new Map<string, { body: string; htmlUrl: string }>()
      const packageReleases = new Map<string, { body: string; htmlUrl: string }>()

      for (const release of releases) {
        const body = release.body?.trim()
        if (!body) continue
        const version = extractVersionFromTag({ tag: release.tag_name })
        if (!version) continue

        const releaseData = { body, htmlUrl: release.html_url ?? '' }
        const packageMatch = release.tag_name.match(/^(.+)@\d+\.\d+\.\d+/)

        if (packageMatch?.[1]) {
          packageReleases.set(`${packageMatch[1]}:${version}`, releaseData)
        } else {
          genericReleases.set(version, releaseData)
        }
      }

      for (const candidate of repoCandidates) {
        const metadata = packageMetadata.get(candidate.name)
        if (!metadata) continue

        const intermediateVersions = getIntermediateVersions({
          publishedVersions: metadata.publishedVersions,
          currentVersion: candidate.currentVersion,
          latestVersion: candidate.latestVersion
        })

        const notes: VersionReleaseNote[] = []
        for (const version of intermediateVersions) {
          const release =
            packageReleases.get(`${candidate.npmName}:${version}`) ?? genericReleases.get(version)
          if (!release) continue

          let body = release.body
          if (body.length > RELEASE_NOTES_MAX_LENGTH) {
            const releaseUrl = release.htmlUrl || `https://github.com/${repo.owner}/${repo.repo}/releases`
            body = `${body.slice(0, RELEASE_NOTES_MAX_LENGTH)}\n\n…[full notes](${releaseUrl})`
          }

          notes.push({ version, body })
        }

        if (notes.length > 0) {
          results.set(candidate.name, notes)
        }
      }
    } catch {
      // Non-critical — skip silently
    } finally {
      semaphore.release()
    }
  })

  await Promise.all(tasks)
  return results
}

/** Build the release notes section for a PR body. */
export function formatReleaseNotes({
  updates,
  releaseNotes
}: {
  updates: UpdateCandidate[]
  releaseNotes: Map<string, VersionReleaseNote[]>
}): string[] {
  const sorted = [...updates].sort((a, b) => a.name.localeCompare(b.name))
  const notesEntries = sorted.filter((u) => releaseNotes.has(u.name))

  if (notesEntries.length === 0) return []

  const lines: string[] = ['', '## Release Notes', '']

  for (const u of notesEntries) {
    const versionNotes = releaseNotes.get(u.name)
    if (!versionNotes || versionNotes.length === 0) continue

    const firstNote = versionNotes[0]
    if (firstNote && versionNotes.length === 1) {
      lines.push(
        '<details>',
        `<summary><b>${u.name}</b> (${u.currentVersion} → ${u.latestVersion})</summary>`,
        '',
        firstNote.body,
        '',
        '</details>',
        ''
      )
    } else {
      lines.push(
        '<details>',
        `<summary><b>${u.name}</b> (${u.currentVersion} → ${u.latestVersion}) — ${versionNotes.length} releases</summary>`,
        ''
      )

      let cumulativeLength = 0
      let rendered = 0
      for (const note of versionNotes) {
        if (cumulativeLength + note.body.length > COMBINED_RELEASE_NOTES_MAX_LENGTH) {
          const remaining = versionNotes.length - rendered
          lines.push(`<p><i>…and ${remaining} more release(s) not shown</i></p>`, '')
          break
        }

        lines.push('<details>', `<summary><b>${note.version}</b></summary>`, '', note.body, '', '</details>', '')
        cumulativeLength += note.body.length
        rendered++
      }

      lines.push('</details>', '')
    }
  }

  return lines
}
