import { afterEach, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { BunFileSystem } from '@effect/platform-bun'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCatalogScopes } from '../src/scopes'
import { type CatalogLocation } from '../src/types'

const dirs: Array<string> = []
afterEach(async () => { await Effect.runPromise(Effect.forEach(dirs.splice(0), dir => Effect.promise(() => rm(dir, { recursive: true, force: true })), { concurrency: "unbounded" })) })

function location(dir: string): CatalogLocation {
  return { dir, providerId: 'bun', definitionRelPath: dir === '.' ? 'package.json' : `${dir}/package.json`, definition: { catalogName: 'default', entries: { typescript: '5.0.0' } } }
}

test('root config governs root and nested catalogs as one update scope', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'catalog-scopes-'))
  dirs.push(cwd)
  await mkdir(join(cwd, 'milkyway'))
  await writeFile(join(cwd, '.catalog-updaterc.json'), JSON.stringify({ minReleaseAgeDays: 7, ignore: [{ pattern: 'pdfjs-dist' }] }))
  const scopes = await Effect.runPromise(resolveCatalogScopes({ cwd, locations: [location('.'), location('milkyway')], configPath: '.catalog-updaterc.json' }).pipe(Effect.provide(BunFileSystem.layer)))
  expect(scopes).toHaveLength(1)
  expect(scopes[0]?.locations.map(l => l.dir)).toEqual(['.', 'milkyway'])
  expect(scopes[0]?.config.minReleaseAgeDays).toBe(7)
  expect(scopes[0]?.config.ignore).toEqual([{ pattern: 'pdfjs-dist', updateTypes: null }])
  expect(scopes[0]?.branchPrefix).toBe('catalog-update')
})

test('a nested config replaces inherited policy and keeps its own PR scope', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'catalog-scopes-'))
  dirs.push(cwd)
  await mkdir(join(cwd, 'milkyway'))
  await writeFile(join(cwd, '.catalog-updaterc.json'), JSON.stringify({ minReleaseAgeDays: 7 }))
  await writeFile(join(cwd, 'milkyway/.catalog-updaterc.json'), JSON.stringify({ minReleaseAgeDays: 14 }))
  const scopes = await Effect.runPromise(resolveCatalogScopes({ cwd, locations: [location('.'), location('milkyway')], configPath: '.catalog-updaterc.json' }).pipe(Effect.provide(BunFileSystem.layer)))
  expect(scopes.map(scope => [scope.branchPrefix, scope.config.minReleaseAgeDays])).toEqual([['catalog-update', 7], ['catalog-update/milkyway', 14]])
})

test('without config, root and nested catalogs retain independent scopes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'catalog-scopes-'))
  dirs.push(cwd)
  const scopes = await Effect.runPromise(resolveCatalogScopes({ cwd, locations: [location('.'), location('milkyway')], configPath: '.catalog-updaterc.json' }).pipe(Effect.provide(BunFileSystem.layer)))
  expect(scopes.map(scope => scope.branchPrefix)).toEqual(['catalog-update', 'catalog-update/milkyway'])
})

test('named catalogs stay separate when they inherit the same config', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'catalog-scopes-'))
  dirs.push(cwd)
  await writeFile(join(cwd, '.catalog-updaterc.json'), '{}')
  const named = { ...location('.'), definition: { catalogName: 'legacy', entries: { typescript: '4.0.0' } } }
  const scopes = await Effect.runPromise(resolveCatalogScopes({ cwd, locations: [location('.'), named, location('milkyway')], configPath: '.catalog-updaterc.json' }).pipe(Effect.provide(BunFileSystem.layer)))
  expect(scopes.map(scope => [scope.branchPrefix, scope.locations.length])).toEqual([['catalog-update', 2], ['catalog-update/legacy', 1]])
})

test('different managers inheriting root config have distinct branch namespaces', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'catalog-scopes-'))
  dirs.push(cwd)
  await writeFile(join(cwd, '.catalog-updaterc.json'), '{}')
  const pnpm: CatalogLocation = { ...location('services'), providerId: 'pnpm', definitionRelPath: 'services/pnpm-workspace.yaml' }
  const scopes = await Effect.runPromise(resolveCatalogScopes({ cwd, locations: [location('.'), pnpm], configPath: '.catalog-updaterc.json' }).pipe(Effect.provide(BunFileSystem.layer)))
  expect(scopes.map(scope => scope.branchPrefix)).toEqual(['catalog-update/bun', 'catalog-update/pnpm'])
})
