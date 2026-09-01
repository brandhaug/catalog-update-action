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
		applyUpdates: applyBunCatalogUpdates
	},
	pnpm: pnpmProvider,
	yarn: yarnProvider
} satisfies Record<ProviderId, CatalogProvider>

export function getProvider({ id }: { id: ProviderId }): CatalogProvider {
	return PROVIDERS[id]
}
