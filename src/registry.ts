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
import { clampNoteBody } from './release-notes'
import {
	extractVersionFromTag,
	getIntermediateVersions,
	highestVersionWhere,
	parseSemver,
	compareSemver
} from './utils'

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
// Exported for tests: body-less releases are the norm for large monorepos
// (e.g. DefinitelyTyped), and one malformed entry must not fail the list.
export const githubReleasesSchema = Schema.Array(
	Schema.Struct({
		tag_name: Schema.String,
		// GitHub emits `"body": null` for body-less releases — an explicit
		// null, not an omitted key — so optionalKey alone is not enough.
		body: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
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
								// Prerelease entry: highest published version above the
								// current one, prereleases included
								const best = highestVersionWhere(
									Object.keys(data.value.versions ?? {}),
									(version) =>
										parseSemver({ version }) !== null &&
										compareSemver({ a: entry.currentVersion, b: version }) < 0
								)
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

									const body = clampNoteBody({
										body: release.body,
										releaseUrl:
											release.htmlUrl ||
											`https://github.com/${repo.owner}/${repo.repo}/releases`
									})

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

/** Parse a GitHub `owner/repo` out of an npm repository URL, or null. */
export function parseGitHubRepo({ url }: { url: string }): GitHubRepo | null {
	const match = url.match(
		/github\.com[/:]([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/
	)
	if (!match?.[1] || !match[2]) {
		return null
	}
	return { owner: match[1], repo: match[2] }
}
