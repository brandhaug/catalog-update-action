import { type PackageMetadata, type UpdateCandidate } from './types'
import {
	classifySemverChange,
	compareSemver,
	highestVersionWhere,
	parseSemver
} from './utils'

/**
 * Release-age quarantine: pure policy deciding which update candidates are
 * old enough to propose, and which older version to fall back to when the
 * latest is still too fresh. The caller supplies `now` and narrates the
 * returned events.
 */

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
	return highestVersionWhere(publishedVersions, (version) => {
		// Skip pre-releases unless current is pre-release
		if (!isPrerelease && version.includes('-')) {
			return false
		}
		if (!parseSemver({ version })) {
			return false
		}
		// Must be an upgrade from current
		if (compareSemver({ a: currentVersion, b: version }) >= 0) {
			return false
		}
		// Must meet the age requirement
		const publishTime = publishTimes[version]
		if (!publishTime) {
			return false
		}
		const ageDays = getVersionAgeDays({ publishTime, nowEpochMs })
		return ageDays !== null && ageDays >= minReleaseAgeDays
	})
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
