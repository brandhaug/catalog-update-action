import { Effect } from 'effect'
import { buildCatalogValue } from './catalog'
import { buildCatalogBranchUpdate } from './git'
import { getProvider } from './providers'
import {
	type BranchUpdate,
	type CatalogLocation,
	type Config,
	type PrSyncPlan,
	type UpdateCandidate,
	type VersionReleaseNote
} from './types'

export type PreparedCatalog = {
	location: CatalogLocation
	groups: Map<string, Array<UpdateCandidate>>
	releaseNotes: Map<string, Array<VersionReleaseNote>>
}

type Target = { location: CatalogLocation; updates: Array<UpdateCandidate> }

/** Groups sharing a package must travel together even when its starting versions differ. */
export function buildCatalogPlans({
	catalogs,
	config,
	branchPrefix,
	cwd
}: {
	catalogs: Array<PreparedCatalog>
	config: Config
	branchPrefix: string
	cwd: string
}): Map<string, PrSyncPlan> {
	const groups = new Map<string, Array<Target>>()
	for (const catalog of catalogs) {
		for (const [name, updates] of catalog.groups) {
			const targets = groups.get(name) ?? []
			targets.push({ location: catalog.location, updates })
			groups.set(name, targets)
		}
	}
	let merged = true
	while (merged) {
		merged = false
		const names = [...groups.keys()].toSorted()
		for (const name of names) {
			const targets = groups.get(name)
			if (!targets) {
				continue
			}
			const packages = new Set(
				targets.flatMap((t) => t.updates.map((u) => u.name))
			)
			for (const other of names) {
				if (other <= name) {
					continue
				}
				const candidates = groups.get(other)
				if (
					candidates?.some((t) => t.updates.some((u) => packages.has(u.name)))
				) {
					targets.push(...candidates)
					groups.delete(other)
					merged = true
				}
			}
		}
	}
	const notes = new Map(catalogs.flatMap((c) => [...c.releaseNotes]))
	const plans = new Map<string, PrSyncPlan>()
	for (const [name, targets] of groups) {
		const parts = targets.map((target) =>
			buildCatalogBranchUpdate({
				groupName: name,
				updates: target.updates,
				config,
				location: target.location,
				cwd,
				branchPrefix,
				releaseNotes: notes
			})
		)
		const first = parts[0]
		if (!first) {
			continue
		}
		const installs = new Map<string, BranchUpdate['installs'][number]>()
		for (const part of parts) {
			for (const install of part.installs) {
				installs.set(install.workDir, install)
			}
		}
		const files = [...new Set(parts.flatMap((p) => p.affectedFiles))]
		const branchUpdate = {
			...first,
			title:
				parts.length === 1
					? first.title
					: `chore(deps): bump ${name} dependencies across catalogs`,
			body: targets
				.map(
					(target, i) =>
						`## ${target.location.definitionRelPath} (${target.location.definition.catalogName})\n\n${parts[i]?.body ?? ''}`
				)
				.join('\n\n'),
			affectedFiles: files,
			expectedBasenames: [
				...new Set(parts.flatMap((p) => p.expectedBasenames))
			],
			installs: [...installs.values()],
			apply: Effect.forEach(parts, (part) => part.apply, { discard: true })
		}
		plans.set(branchUpdate.branch, {
			branchUpdate,
			isOutdated: ({ branchFiles }) =>
				targets.some((target) => {
					const content = branchFiles.get(target.location.definitionRelPath)
					if (!content) {
						return true
					}
					const definitions = getProvider(
						target.location.providerId
					).parseDefinitions({ content })
					const definition = definitions.find(
						(d) => d.catalogName === target.location.definition.catalogName
					)
					return (
						!definition ||
						target.updates.some(
							(update) =>
								definition.entries[update.name] !==
								buildCatalogValue({ update })
						)
					)
				})
		})
	}
	return plans
}
