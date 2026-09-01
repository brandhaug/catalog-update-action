import { applyBunCatalogUpdates, bunAudit, parseBunCatalogs } from './bun'
import { pnpmProvider } from './pnpm'
import { yarnProvider } from './yarn'
import { type CatalogProvider, type ProviderId } from './types'

export type {
	AuditCapability,
	CatalogProvider,
	ParsedCatalog,
	ProviderId
} from './types'

export const PROVIDERS = {
	bun: {
		id: 'bun',
		installCommand: ['bun', 'install'],
		lockfileName: 'bun.lock',
		// bun audit exits non-zero when vulnerabilities are found, which is the
		// expected (successful) case — runAudit reads the JSON output either way.
		audit: bunAudit,
		parseDefinitions: parseBunCatalogs,
		applyUpdates: applyBunCatalogUpdates,
		// Older Bun versions write the binary bun.lockb format instead.
		installArtifacts: ['bun.lock', 'bun.lockb']
	},
	pnpm: pnpmProvider,
	yarn: yarnProvider
} satisfies Record<ProviderId, CatalogProvider>

export function getProvider(id: ProviderId): CatalogProvider {
	return PROVIDERS[id]
}

/**
 * Basenames that may legitimately change on disk when the provider's install
 * runs: the files the update itself touches, plus the provider's own
 * artifacts. Used to warn about unexpected install writes.
 */
export function expectedInstallBasenames({
	provider,
	affectedFiles
}: {
	provider: CatalogProvider
	affectedFiles: Array<string>
}): Array<string> {
	return [
		...new Set([
			...affectedFiles.map((path) => path.split('/').pop() ?? path),
			...provider.installArtifacts
		])
	]
}
