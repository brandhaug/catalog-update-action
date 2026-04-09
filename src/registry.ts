import type {
	CatalogEntry,
	GitHubRepo,
	PackageMetadata,
	UpdateCandidate,
	VersionReleaseNote
} from './types'
import {
	classifySemverChange,
	compareSemver,
	extractVersionFromTag,
	getIntermediateVersions,
	parseSemver,
	Semaphore
} from './utils'

const RELEASE_NOTES_MAX_LENGTH = 2000
const COMBINED_RELEASE_NOTES_MAX_LENGTH = 5000

/** Retries fetch on transient failures (429, 5xx) or network errors. */
async function fetchWithRetry(
	url: string,
	init: RequestInit,
	retries = 1
): Promise<Response> {
	let lastError: unknown
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const response = await fetch(url, init)
			if (response.ok || attempt === retries) return response
			if (response.status === 429 || response.status >= 500) {
				await Bun.sleep(1000 * (attempt + 1))
				continue
			}
			return response // 4xx client error, don't retry
		} catch (error) {
			lastError = error
			if (attempt < retries) {
				await Bun.sleep(1000 * (attempt + 1))
			}
		}
	}
	throw lastError
}

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
			const response = await fetchWithRetry(
				`https://registry.npmjs.org/${encodedName}`,
				{
					headers: { Accept: 'application/vnd.npm.install-v1+json' },
					signal: AbortSignal.timeout(15_000)
				}
			)

			if (!response.ok) {
				console.warn(
					`  Warning: Failed to fetch ${entry.npmName} (${response.status})`
				)
				return
			}

			const data = (await response.json()) as {
				'dist-tags'?: { latest?: string }
				versions?: Record<string, unknown>
			}

			if (parseSemver({ version: entry.currentVersion })?.prerelease) {
				// Prerelease entry: find highest version from all published versions
				const allVersions = data.versions ? Object.keys(data.versions) : []
				let best: string | null = null
				for (const v of allVersions) {
					if (!parseSemver({ version: v })) continue
					if (compareSemver({ a: entry.currentVersion, b: v }) >= 0) continue
					if (!best || compareSemver({ a: best, b: v }) < 0) best = v
				}
				if (best) results.set(entry.name, best)
			} else {
				// Stable entry: use dist-tags.latest, reject prereleases
				const latest = data['dist-tags']?.latest
				if (latest && !latest.includes('-')) {
					results.set(entry.name, latest)
				}
			}
		} catch (error: unknown) {
			const message =
				error instanceof Error ? (error.stack ?? error.message) : String(error)
			console.warn(`  Warning: Error fetching ${entry.npmName}: ${message}`)
		} finally {
			semaphore.release()
		}
	})

	await Promise.all(tasks)
	return results
}

// ---------------------------------------------------------------------------
// Release age filtering
// ---------------------------------------------------------------------------

/** Returns the age of a version in days based on its npm publish time, or null if unknown. */
export function getVersionAgeDays({
	publishTime,
	now
}: {
	publishTime: string
	now: Date
}): number | null {
	const publishDate = new Date(publishTime)
	if (Number.isNaN(publishDate.getTime())) return null
	return (now.getTime() - publishDate.getTime()) / (1000 * 60 * 60 * 24)
}

/**
 * Filter candidates by minimum release age. For each candidate whose latest version
 * is too young, attempt to find the newest published version that satisfies the age
 * requirement and is still an upgrade from current. If none qualifies, the candidate
 * is removed.
 */
export function filterByReleaseAge({
	candidates,
	packageMetadata,
	minReleaseAgeDays,
	now = new Date()
}: {
	candidates: UpdateCandidate[]
	packageMetadata: Map<string, PackageMetadata>
	minReleaseAgeDays: number
	now?: Date
}): UpdateCandidate[] {
	if (minReleaseAgeDays <= 0) return candidates

	const filtered: UpdateCandidate[] = []

	for (const candidate of candidates) {
		const metadata = packageMetadata.get(candidate.name)
		const publishTimes = metadata?.publishTimes ?? {}

		const latestPublishTime = publishTimes[candidate.latestVersion]
		if (!latestPublishTime) {
			// No publish time data — allow the update (don't block on missing data)
			filtered.push(candidate)
			continue
		}

		const ageDays = getVersionAgeDays({ publishTime: latestPublishTime, now })
		if (ageDays === null || ageDays >= minReleaseAgeDays) {
			filtered.push(candidate)
			continue
		}

		// Latest version is too young — find the best qualifying version
		const bestVersion = findBestQualifyingVersion({
			currentVersion: candidate.currentVersion,
			publishedVersions: metadata?.publishedVersions ?? [],
			publishTimes,
			minReleaseAgeDays,
			isPrerelease: candidate.currentVersion.includes('-'),
			now
		})

		if (bestVersion) {
			const changeType = classifySemverChange({
				from: candidate.currentVersion,
				to: bestVersion
			})
			if (changeType) {
				filtered.push({ ...candidate, latestVersion: bestVersion, changeType })
				console.log(
					`    ${candidate.name}: ${candidate.latestVersion} is ${Math.max(0, ageDays).toFixed(0)} day(s) old ` +
						`(minimum: ${minReleaseAgeDays}), falling back to ${bestVersion}`
				)
				continue
			}
		}

		console.log(
			`    Skipping ${candidate.name} ${candidate.latestVersion}: ` +
				`published ${Math.max(0, ageDays).toFixed(0)} day(s) ago (minimum: ${minReleaseAgeDays} days)`
		)
	}

	return filtered
}

/** Find the newest published version that is older than minReleaseAgeDays and newer than currentVersion. */
function findBestQualifyingVersion({
	currentVersion,
	publishedVersions,
	publishTimes,
	minReleaseAgeDays,
	isPrerelease,
	now
}: {
	currentVersion: string
	publishedVersions: string[]
	publishTimes: Record<string, string>
	minReleaseAgeDays: number
	isPrerelease: boolean
	now: Date
}): string | null {
	let best: string | null = null

	for (const version of publishedVersions) {
		// Skip pre-releases unless current is pre-release
		if (!isPrerelease && version.includes('-')) continue
		if (!parseSemver({ version })) continue

		// Must be an upgrade from current
		if (compareSemver({ a: currentVersion, b: version }) >= 0) continue

		// Must meet the age requirement
		const publishTime = publishTimes[version]
		if (!publishTime) continue

		const ageDays = getVersionAgeDays({ publishTime, now })
		if (ageDays === null || ageDays < minReleaseAgeDays) continue

		// Keep the newest qualifying version
		if (!best || compareSemver({ a: best, b: version }) < 0) {
			best = version
		}
	}

	return best
}

// ---------------------------------------------------------------------------
// Package metadata (GitHub repo URLs + published versions)
// ---------------------------------------------------------------------------

function parseGitHubRepo({ url }: { url: string }): GitHubRepo | null {
	const match = url.match(
		/github\.com[/:]([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/
	)
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
			const response = await fetchWithRetry(
				`https://registry.npmjs.org/${encodedName}`,
				{
					headers: { Accept: 'application/json' },
					signal: AbortSignal.timeout(15_000)
				}
			)

			if (!response.ok) return

			const data = (await response.json()) as {
				repository?: { url?: string }
				versions?: Record<string, unknown>
				time?: Record<string, string>
			}

			const repoUrl = data.repository?.url
			const repo = repoUrl ? parseGitHubRepo({ url: repoUrl }) : null

			const publishedVersions = data.versions ? Object.keys(data.versions) : []
			const publishTimes = data.time ?? {}
			const metadata: PackageMetadata = {
				repo,
				publishedVersions,
				publishTimes
			}

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
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github+json'
	}
	if (githubToken) {
		headers.Authorization = `Bearer ${githubToken}`
	}

	const repoKey = (repo: GitHubRepo): string => `${repo.owner}/${repo.repo}`
	const repoToCandidates = new Map<
		string,
		{ repo: GitHubRepo; candidates: UpdateCandidate[] }
	>()

	for (const candidate of candidates) {
		const metadata = packageMetadata.get(candidate.name)
		if (!metadata?.repo) continue
		const key = repoKey(metadata.repo)
		const existing = repoToCandidates.get(key)
		if (existing) {
			existing.candidates.push(candidate)
		} else {
			repoToCandidates.set(key, {
				repo: metadata.repo,
				candidates: [candidate]
			})
		}
	}

	const tasks = [...repoToCandidates.values()].map(
		async ({ repo, candidates: repoCandidates }) => {
			await semaphore.acquire()
			try {
				const response = await fetchWithRetry(
					`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=100`,
					{ headers, signal: AbortSignal.timeout(15_000) }
				)
				if (!response.ok) return

				const releases = (await response.json()) as Array<{
					tag_name: string
					body?: string
					html_url?: string
				}>

				const genericReleases = new Map<
					string,
					{ body: string; htmlUrl: string }
				>()
				const packageReleases = new Map<
					string,
					{ body: string; htmlUrl: string }
				>()

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
						latestVersion: candidate.latestVersion,
						includePrerelease: candidate.currentVersion.includes('-')
					})

					const notes: VersionReleaseNote[] = []
					for (const version of intermediateVersions) {
						const release =
							packageReleases.get(`${candidate.npmName}:${version}`) ??
							genericReleases.get(version)
						if (!release) continue

						let body = release.body
						if (body.length > RELEASE_NOTES_MAX_LENGTH) {
							const releaseUrl =
								release.htmlUrl ||
								`https://github.com/${repo.owner}/${repo.repo}/releases`
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
		}
	)

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
	const sorted = [...updates].toSorted((a, b) => a.name.localeCompare(b.name))
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
				if (
					cumulativeLength + note.body.length >
					COMBINED_RELEASE_NOTES_MAX_LENGTH
				) {
					const remaining = versionNotes.length - rendered
					lines.push(
						`<p><i>…and ${remaining} more release(s) not shown</i></p>`,
						''
					)
					break
				}

				lines.push(
					'<details>',
					`<summary><b>${note.version}</b></summary>`,
					'',
					note.body,
					'',
					'</details>',
					''
				)
				cumulativeLength += note.body.length
				rendered++
			}

			lines.push('</details>', '')
		}
	}

	return lines
}
