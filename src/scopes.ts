import { Effect, FileSystem, Path } from 'effect'
import { loadConfig } from './config'
import { type CatalogLocation, type Config } from './types'

export type CatalogScope = {
	dir: string
	branchPrefix: string
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
				locations: [location]
			})
		}
		return [...scopes.values()]
	},
	Effect.provide(Path.layer)
)
