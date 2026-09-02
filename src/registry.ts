import {
	Config,
	Context,
	Effect,
	Layer,
	Option,
	Schema,
	Schedule
} from 'effect'
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse
} from 'effect/unstable/http'
import {
	type CatalogEntry,
	type GitHubRepo,
	type PackageMetadata,
	type UpdateCandidate,
	type VersionReleaseNote
} from './types'
import {
	classifySemverChange,
	compareSemver,
	extractVersionFromTag,
	getIntermediateVersions,
	parseSemver
} from './utils'

const RELEASE_NOTES_MAX_LENGTH = 2000
const COMBINED_RELEASE_NOTES_MAX_LENGTH = 5000

/** Total time budget for one registry call, including its retry. */
const REQUEST_TIMEOUT = '15 seconds'
/** One retry after the initial attempt, with exponential backoff. */
const RETRY_SCHEDULE = Schedule.exponential('1 second')

const registryRequest = (npmName: string, accept: string) =>
	HttpClientRequest.get(
		`https://registry.npmjs.org/${npmName.replace('/', '%2f')}`
	).pipe(HttpClientRequest.setHeader('Accept', accept))

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

/** Shape of the npm registry `install-v1` response for a package. */
const npmRegistryResponseSchema = Schema.Struct({
	'dist-tags': Schema.optionalKey(Schema.Struct({ latest: Schema.String })),
	versions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
})

/** Shape of the npm registry full-metadata response for a package. */
const npmMetadataResponseSchema = Schema.Struct({
	repository: Schema.optionalKey(Schema.Struct({ url: Schema.String })),
	versions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
	time: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
})

/** Shape of the GitHub releases list response. */
const githubReleasesSchema = Schema.Array(
	Schema.Struct({
		tag_name: Schema.String,
		body: Schema.optionalKey(Schema.String),
		html_url: Schema.optionalKey(Schema.String)
	})
)

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Reads version and release data from the npm registry and GitHub releases.
 *
 * Query methods never fail: package lookups are best-effort, so a package
 * that cannot be fetched or decoded is warned about and skipped, exactly as
 * if the registry had no data for it.
 */
export class Registry extends Context.Service<
	Registry,
	{
		/** Latest available version per catalog entry name. */
		queryNpmRegistry(input: {
			readonly entries: Array<CatalogEntry>
			readonly concurrency: number
		}): Effect.Effect<Map<string, string>>

		/** Repo URL, published versions and publish times per candidate name. */
		queryPackageMetadata(input: {
			readonly candidates: Array<UpdateCandidate>
			readonly concurrency: number
		}): Effect.Effect<Map<string, PackageMetadata>>

		/** Release notes per candidate name, newest version first. */
		queryReleaseNotes(input: {
			readonly candidates: Array<UpdateCandidate>
			readonly packageMetadata: Map<string, PackageMetadata>
			readonly concurrency: number
		}): Effect.Effect<Map<string, Array<VersionReleaseNote>>>
	}
>()('catalog-update/Registry') {
	static readonly layer = Layer.effect(
		Registry,
		Effect.gen(function* () {
			const client = (yield* HttpClient.HttpClient).pipe(
				// Retries transport errors, timeouts, 408, 429 and 5xx — the same
				// transient set fetchWithRetry used to handle by hand.
				HttpClient.retryTransient({ schedule: RETRY_SCHEDULE, times: 1 })
			)
			const githubToken = yield* Config.option(Config.string('GITHUB_TOKEN'))

			/**
			 * Execute a request and decode the body with `schema`, classifying the
			 * outcome: `Some` on a decoded 2xx response, `None` when the package
			 * has no usable data — a non-2xx status, a transport/timeout failure
			 * or a decode failure, each warned about here so the query loops can
			 * simply skip `None`.
			 */
			const fetchJson = <
				S extends Schema.Constraint & { readonly DecodingServices: never }
			>(
				operation: string,
				request: HttpClientRequest.HttpClientRequest,
				schema: S
			): Effect.Effect<Option.Option<S['Type']>> =>
				Effect.gen(function* () {
					const response = yield* client
						.execute(request)
						.pipe(Effect.timeout(REQUEST_TIMEOUT))

					if (response.status >= 400) {
						yield* Effect.logWarning(
							`  Warning: ${operation} failed (${response.status})`
						)
						return Option.none()
					}

					return yield* HttpClientResponse.schemaBodyJson(schema)(
						response
					).pipe(Effect.map(Option.some))
				}).pipe(
					// Transport/timeout/decode failures are per-package concerns:
					// warn and report "no data", mirroring the old per-entry
					// catch-and-skip behavior.
					Effect.catch((error) =>
						Effect.logWarning(
							`  Warning: ${operation} failed: ${String(error)}`
						).pipe(Effect.as(Option.none()))
					)
				)

			const queryNpmRegistry = Effect.fn('Registry.queryNpmRegistry')(
				function* ({
					entries,
					concurrency
				}: {
					readonly entries: Array<CatalogEntry>
					readonly concurrency: number
				}) {
					const results = new Map<string, string>()

					yield* Effect.forEach(
						entries,
						Effect.fn('Registry.queryNpmRegistry.entry')(function* (entry) {
							const data = yield* fetchJson(
								`fetch ${entry.npmName}`,
								registryRequest(
									entry.npmName,
									'application/vnd.npm.install-v1+json'
								),
								npmRegistryResponseSchema
							)

							if (Option.isNone(data)) {
								return
							}

							if (parseSemver({ version: entry.currentVersion })?.prerelease) {
								// Prerelease entry: find highest version from all published versions
								const allVersions = data.value.versions
									? Object.keys(data.value.versions)
									: []
								let best: string | null = null
								for (const v of allVersions) {
									if (!parseSemver({ version: v })) {
										continue
									}
									if (compareSemver({ a: entry.currentVersion, b: v }) >= 0) {
										continue
									}
									if (!best || compareSemver({ a: best, b: v }) < 0) {
										best = v
									}
								}
								if (best) {
									results.set(entry.name, best)
								}
							} else {
								// Stable entry: use dist-tags.latest, reject prereleases
								const latest = data.value['dist-tags']?.latest
								if (latest && !latest.includes('-')) {
									results.set(entry.name, latest)
								}
							}
						}),
						{ concurrency, discard: true }
					)

					return results
				}
			)

			const queryPackageMetadata = Effect.fn('Registry.queryPackageMetadata')(
				function* ({
					candidates,
					concurrency
				}: {
					readonly candidates: Array<UpdateCandidate>
					readonly concurrency: number
				}) {
					const results = new Map<string, PackageMetadata>()

					// One fetch per distinct npmName; aliases of the same package
					// (catalog name ≠ npm name) share the result. Grouping up front
					// keeps concurrent loops from double-fetching, matching the
					// repo-grouped release-notes query below.
					const byNpmName = new Map<string, Array<UpdateCandidate>>()
					for (const candidate of candidates) {
						const group = byNpmName.get(candidate.npmName)
						if (group) {
							group.push(candidate)
						} else {
							byNpmName.set(candidate.npmName, [candidate])
						}
					}

					yield* Effect.forEach(
						[...byNpmName],
						Effect.fn('Registry.queryPackageMetadata.package')(function* ([
							npmName,
							group
						]) {
							const data = yield* fetchJson(
								`fetch metadata for ${npmName}`,
								registryRequest(npmName, 'application/json'),
								npmMetadataResponseSchema
							)

							if (Option.isNone(data)) {
								return
							}

							const repoUrl = data.value.repository?.url
							const metadata: PackageMetadata = {
								repo: repoUrl ? parseGitHubRepo({ url: repoUrl }) : null,
								publishedVersions: data.value.versions
									? Object.keys(data.value.versions)
									: [],
								publishTimes: data.value.time ?? {}
							}
							for (const candidate of group) {
								results.set(candidate.name, metadata)
							}
						}),
						{ concurrency, discard: true }
					)

					return results
				}
			)

			const queryReleaseNotes = Effect.fn('Registry.queryReleaseNotes')(
				function* ({
					candidates,
					packageMetadata,
					concurrency
				}: {
					readonly candidates: Array<UpdateCandidate>
					readonly packageMetadata: Map<string, PackageMetadata>
					readonly concurrency: number
				}) {
					const results = new Map<string, Array<VersionReleaseNote>>()

					const headers = Option.isSome(githubToken)
						? {
								Accept: 'application/vnd.github+json',
								Authorization: `Bearer ${githubToken.value}`
							}
						: { Accept: 'application/vnd.github+json' }

					const repoToCandidates = new Map<
						string,
						{ repo: GitHubRepo; candidates: Array<UpdateCandidate> }
					>()
					for (const candidate of candidates) {
						const metadata = packageMetadata.get(candidate.name)
						if (!metadata?.repo) {
							continue
						}
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

					yield* Effect.forEach(
						[...repoToCandidates.values()],
						Effect.fn('Registry.queryReleaseNotes.repo')(function* ({
							repo,
							candidates: repoCandidates
						}) {
							const releases = yield* fetchJson(
								`fetch releases for ${repoKey(repo)}`,
								HttpClientRequest.get(
									`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=100`
								).pipe(HttpClientRequest.setHeaders(headers)),
								githubReleasesSchema
							)

							if (Option.isNone(releases)) {
								return
							}

							const genericReleases = new Map<
								string,
								{ body: string; htmlUrl: string }
							>()
							const packageReleases = new Map<
								string,
								{ body: string; htmlUrl: string }
							>()

							for (const release of releases.value) {
								const body = release.body?.trim()
								if (!body) {
									continue
								}
								const version = extractVersionFromTag({ tag: release.tag_name })
								if (!version) {
									continue
								}

								const releaseData = { body, htmlUrl: release.html_url ?? '' }
								const packageMatch =
									release.tag_name.match(/^(.+)@\d+\.\d+\.\d+/)

								if (packageMatch?.[1]) {
									packageReleases.set(
										`${packageMatch[1]}:${version}`,
										releaseData
									)
								} else {
									genericReleases.set(version, releaseData)
								}
							}

							for (const candidate of repoCandidates) {
								const metadata = packageMetadata.get(candidate.name)
								if (!metadata) {
									continue
								}

								const intermediateVersions = getIntermediateVersions({
									publishedVersions: metadata.publishedVersions,
									currentVersion: candidate.currentVersion,
									latestVersion: candidate.latestVersion,
									includePrerelease: candidate.currentVersion.includes('-')
								})

								const notes: Array<VersionReleaseNote> = []
								for (const version of intermediateVersions) {
									const release =
										packageReleases.get(`${candidate.npmName}:${version}`) ??
										genericReleases.get(version)
									if (!release) {
										continue
									}

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
						}),
						{ concurrency, discard: true }
					)

					return results
				}
			)

			return Registry.of({
				queryNpmRegistry,
				queryPackageMetadata,
				queryReleaseNotes
			})
		})
	).pipe(
		// The fetch transport is an implementation detail; consumers only see
		// the Registry service.
		Layer.provide(FetchHttpClient.layer)
	)
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const repoKey = (repo: GitHubRepo): string => `${repo.owner}/${repo.repo}`

function parseGitHubRepo({ url }: { url: string }): GitHubRepo | null {
	const match = url.match(
		/github\.com[/:]([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/
	)
	if (!match?.[1] || !match[2]) {
		return null
	}
	return { owner: match[1], repo: match[2] }
}

/** Returns the age of a version in days based on its npm publish time, or null if unknown. */
export function getVersionAgeDays({
	publishTime,
	nowEpochMs
}: {
	publishTime: string
	nowEpochMs: number
}): number | null {
	// new Date(publishTime) parses the ISO 8601 timestamps npm's registry
	// metadata returns; it never reads the wall clock. The current time is
	// injected by the caller from Effect's Clock (DateTime.now).
	// oxlint-disable-next-line effect/noGlobals
	const publishDate = new Date(publishTime)
	if (Number.isNaN(publishDate.getTime())) {
		return null
	}
	return (nowEpochMs - publishDate.getTime()) / (1000 * 60 * 60 * 24)
}

export type ReleaseAgeEvent = {
	readonly name: string
	readonly message: string
}

/** Candidates that survived the release-age quarantine, plus its narration. */
export type ReleaseAgeFilter = {
	candidates: Array<UpdateCandidate>
	events: Array<ReleaseAgeEvent>
}

/** Find the newest published version that is older than minReleaseAgeDays and newer than currentVersion. */
function findBestQualifyingVersion({
	currentVersion,
	publishedVersions,
	publishTimes,
	minReleaseAgeDays,
	isPrerelease,
	nowEpochMs
}: {
	currentVersion: string
	publishedVersions: Array<string>
	publishTimes: Record<string, string>
	minReleaseAgeDays: number
	isPrerelease: boolean
	nowEpochMs: number
}): string | null {
	let best: string | null = null

	for (const version of publishedVersions) {
		// Skip pre-releases unless current is pre-release
		if (!isPrerelease && version.includes('-')) {
			continue
		}
		if (!parseSemver({ version })) {
			continue
		}

		// Must be an upgrade from current
		if (compareSemver({ a: currentVersion, b: version }) >= 0) {
			continue
		}

		// Must meet the age requirement
		const publishTime = publishTimes[version]
		if (!publishTime) {
			continue
		}

		const ageDays = getVersionAgeDays({ publishTime, nowEpochMs })
		if (ageDays === null || ageDays < minReleaseAgeDays) {
			continue
		}

		// Keep the newest qualifying version
		if (!best || compareSemver({ a: best, b: version }) < 0) {
			best = version
		}
	}

	return best
}

/**
 * Filter candidates by minimum release age. For each candidate whose latest version
 * is too young, attempt to find the newest published version that satisfies the age
 * requirement and is still an upgrade from current. If none qualifies, the candidate
 * is removed.
 *
 * Pure: the caller supplies `now` and narrates the returned events.
 */
export function filterByReleaseAge({
	candidates,
	packageMetadata,
	minReleaseAgeDays,
	nowEpochMs
}: {
	candidates: Array<UpdateCandidate>
	packageMetadata: Map<string, PackageMetadata>
	minReleaseAgeDays: number
	nowEpochMs: number
}): ReleaseAgeFilter {
	if (minReleaseAgeDays <= 0) {
		return { candidates, events: [] }
	}

	const filtered: Array<UpdateCandidate> = []
	const events: Array<ReleaseAgeEvent> = []

	for (const candidate of candidates) {
		const metadata = packageMetadata.get(candidate.name)
		const publishTimes = metadata?.publishTimes ?? {}

		const latestPublishTime = publishTimes[candidate.latestVersion]
		if (!latestPublishTime) {
			// No publish time data — allow the update (don't block on missing data)
			filtered.push(candidate)
			continue
		}

		const ageDays = getVersionAgeDays({
			publishTime: latestPublishTime,
			nowEpochMs
		})
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
			nowEpochMs
		})

		if (bestVersion) {
			const changeType = classifySemverChange({
				from: candidate.currentVersion,
				to: bestVersion
			})
			if (changeType) {
				filtered.push({ ...candidate, latestVersion: bestVersion, changeType })
				events.push({
					name: candidate.name,
					message:
						`    ${candidate.name}: ${candidate.latestVersion} is ${Math.max(0, ageDays).toFixed(0)} day(s) old ` +
						`(minimum: ${minReleaseAgeDays}), falling back to ${bestVersion}`
				})
				continue
			}
		}

		events.push({
			name: candidate.name,
			message:
				`    Skipping ${candidate.name} ${candidate.latestVersion}: ` +
				`published ${Math.max(0, ageDays).toFixed(0)} day(s) ago (minimum: ${minReleaseAgeDays} days)`
		})
	}

	return { candidates: filtered, events }
}

/** Build the release notes section for a PR body. */
export function formatReleaseNotes({
	updates,
	releaseNotes
}: {
	updates: Array<UpdateCandidate>
	releaseNotes: Map<string, Array<VersionReleaseNote>>
}): Array<string> {
	const sorted = [...updates].toSorted((a, b) => a.name.localeCompare(b.name))
	const notesEntries = sorted.filter((u) => releaseNotes.has(u.name))

	if (notesEntries.length === 0) {
		return []
	}

	const lines: Array<string> = ['', '## Release Notes', '']

	for (const u of notesEntries) {
		const versionNotes = releaseNotes.get(u.name)
		if (!versionNotes || versionNotes.length === 0) {
			continue
		}

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
