import { Effect, FileSystem, Path } from 'effect'
import { loadConfig } from './config'
import { type CatalogLocation, type Config } from './types'

export type CatalogScope = {
	dir: string
	branchPrefix: string
	branchNamespace: string
	config: Config
	locations: Array<CatalogLocation>
}

export const resolveCatalogScopes = Effect.fn('Scopes.resolveCatalogScopes')(
	function* ({
		cwd,
		locations,
		configPath
	}: {
		cwd: string
		locations: Array<CatalogLocation>
		configPath: string
	}) {
		const fs = yield* FileSystem.FileSystem
		const pathService = yield* Path.Path
		const scopes = new Map<string, CatalogScope>()
		for (const location of locations) {
			let configDir = location.dir
			let path = pathService.resolve(cwd, configDir, configPath)
			while (!pathService.isAbsolute(configPath)) {
				const exists = yield* fs.exists(path).pipe(Effect.orDie)
				if (exists || configDir === '.') {
					break
				}
				configDir = pathService.dirname(configDir)
				path = pathService.resolve(cwd, configDir, configPath)
			}
			const exists = yield* fs.exists(path).pipe(Effect.orDie)
			// Without a shared config, keep each location independent.
			let dir = location.dir
			if (exists) {
				dir = pathService.isAbsolute(configPath) ? '.' : configDir
			}
			const key = [
				exists ? path : location.definitionRelPath,
				location.providerId,
				location.definition.catalogName
			].join('\0')
			const existing = scopes.get(key)
			if (existing) {
				existing.locations.push(location)
				continue
			}
			const config = yield* loadConfig({ configPath: path })
			const segments = [config.branchPrefix]
			if (dir !== '.') {
				segments.push(dir)
			}
			if (location.definition.catalogName !== 'default') {
				segments.push(location.definition.catalogName)
			}
			scopes.set(key, {
				dir,
				config,
				branchPrefix: segments.join('/'),
				branchNamespace: config.branchPrefix,
				locations: [location]
			})
		}
		const resolved = [...scopes.values()]
		const owners = new Map<string, number>()
		for (const scope of resolved) {
			owners.set(scope.branchPrefix, (owners.get(scope.branchPrefix) ?? 0) + 1)
		}
		for (const scope of resolved) {
			if ((owners.get(scope.branchPrefix) ?? 0) > 1) {
				const provider = scope.locations[0]?.providerId
				if (provider) {
					scope.branchNamespace = `${scope.config.branchPrefix}/${provider}`
					scope.branchPrefix = scope.branchPrefix.replace(
						scope.config.branchPrefix,
						scope.branchNamespace
					)
				}
			}
		}
		return resolved
	},
	Effect.provide(Path.layer)
)
