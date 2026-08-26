import { type Config, type SemverChange, type UpdateCandidate } from './types'
import { matchesAnyPattern, matchesGlob } from './utils'

export function shouldIgnore({
	name,
	changeType,
	rules
}: {
	name: string
	changeType: SemverChange
	rules: Config['ignore']
}): boolean {
	return rules.some((rule) => {
		if (!matchesGlob({ name, pattern: rule.pattern })) return false
		if (rule.updateTypes === null) return true
		return rule.updateTypes.includes(changeType)
	})
}

export function assignToGroups({
	candidates,
	groups
}: {
	candidates: UpdateCandidate[]
	groups: Config['groups']
}): Map<string, UpdateCandidate[]> {
	const result = new Map<string, UpdateCandidate[]>()
	const assigned = new Set<string>()

	for (const group of groups) {
		const members: UpdateCandidate[] = []

		for (const candidate of candidates) {
			if (assigned.has(candidate.name)) continue
			if (
				!matchesAnyPattern({ name: candidate.name, patterns: group.patterns })
			) {
				continue
			}
			if (
				group.updateTypes !== null &&
				!group.updateTypes.includes(candidate.changeType)
			) {
				continue
			}

			members.push(candidate)
			assigned.add(candidate.name)
		}

		if (members.length > 0) {
			result.set(group.name, members)
		}
	}

	// Collapse patch-only groups into all-patch-updates to reduce PR noise,
	// but only when the user actually configured a catch-all group: a patch-only
	// group keeps its own PR otherwise instead of being funneled into a phantom
	// catch-all the user never defined.
	const CATCH_ALL = 'all-patch-updates'
	const catchAllConfigured = groups.some((group) => group.name === CATCH_ALL)
	for (const [groupName, members] of result) {
		if (groupName === CATCH_ALL) continue
		const hasMajorOrMinor = members.some(
			(m) =>
				m.changeType !== 'patch' &&
				m.changeType !== 'prerelease' &&
				m.changeType !== 'release'
		)
		if (hasMajorOrMinor) continue
		if (!catchAllConfigured) continue

		const patchGroup = result.get(CATCH_ALL) ?? []
		patchGroup.push(...members)
		result.set(CATCH_ALL, patchGroup)
		result.delete(groupName)
	}

	return result
}
