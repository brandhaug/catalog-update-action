import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { discoverCatalogLocations } from '../src/discover'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type JsonObject } from '../src/schemas'

const FIXTURE_DIR = join(import.meta.dir, '.fixtures-discover')

function writeJsonObject(dir: string, content: JsonObject): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(content, null, 2))
}

function writeText(dir: string, file: string, content: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), content)
}

beforeEach(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
})

describe('discoverCatalogLocations', () => {
  test('finds root bun catalog', async () => {
    writeJsonObject(FIXTURE_DIR, { catalog: { react: '19.0.0' } })

    const result = await discoverCatalogLocations({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      dir: '.',
      providerId: 'bun',
      definitionRelPath: 'package.json',
      definition: { catalogName: 'default', entries: { react: '19.0.0' } }
    })
  })

  test('finds nested bun catalogs', async () => {
    writeJsonObject(join(FIXTURE_DIR, 'apps/frontend'), { catalog: { react: '19.0.0' } })
    writeJsonObject(join(FIXTURE_DIR, 'apps/backend'), { catalog: { express: '5.0.0' } })

    const result = await discoverCatalogLocations({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result.map((l) => l.dir)).toEqual(['apps/backend', 'apps/frontend'])
  })

  test('finds pnpm catalogs in pnpm-workspace.yaml', async () => {
    writeText(
      FIXTURE_DIR,
      'pnpm-workspace.yaml',
      'packages:\n  - packages/*\n\ncatalog:\n  react: ^19.0.0\n\ncatalogs:\n  react18:\n    react: ^18.3.1\n'
    )

    const result = await discoverCatalogLocations({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result).toHaveLength(2)
    expect(result.map((l) => l.definition.catalogName)).toEqual(['default', 'react18'])
    expect(result[0]).toMatchObject({
      dir: '.',
      providerId: 'pnpm',
      definitionRelPath: 'pnpm-workspace.yaml'
    })
    expect(result[1]?.definition.entries).toEqual({ react: '^18.3.1' })
  })

  test('finds yarn catalogs in .yarnrc.yml', async () => {
    writeText(
      FIXTURE_DIR,
      '.yarnrc.yml',
      'nodeLinker: node-modules\n\ncatalog:\n  lodash: ^4.17.21\n'
    )

    const result = await discoverCatalogLocations({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      dir: '.',
      providerId: 'yarn',
      definitionRelPath: '.yarnrc.yml',
      definition: { catalogName: 'default', entries: { lodash: '^4.17.21' } }
    })
  })

  test('finds catalogs across all providers in the same repo', async () => {
    writeJsonObject(FIXTURE_DIR, { catalog: { react: '19.0.0' } })
    writeText(FIXTURE_DIR, 'pnpm-workspace.yaml', 'catalog:\n  vue: ^3.5.0\n')
    writeText(FIXTURE_DIR, '.yarnrc.yml', 'catalog:\n  svelte: ^5.0.0\n')

    const result = await discoverCatalogLocations({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result.map((l) => l.providerId)).toEqual(['bun', 'pnpm', 'yarn'])
  })

  test('skips files without catalog definitions', async () => {
    writeJsonObject(FIXTURE_DIR, { name: 'root', dependencies: { react: '19.0.0' } })
    writeText(FIXTURE_DIR, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n')
    writeText(FIXTURE_DIR, '.yarnrc.yml', 'nodeLinker: node-modules\n')

    const result = await discoverCatalogLocations({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result).toEqual([])
  })

  test('skips node_modules', async () => {
    writeJsonObject(FIXTURE_DIR, { catalog: { react: '19.0.0' } })
    writeJsonObject(join(FIXTURE_DIR, 'node_modules/react'), { catalog: { scheduler: '1.0.0' } })

    const result = await discoverCatalogLocations({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result.map((l) => l.dir)).toEqual(['.'])
  })

  test('excludes exact directory', async () => {
    writeJsonObject(FIXTURE_DIR, { catalog: { react: '19.0.0' } })
    writeJsonObject(join(FIXTURE_DIR, 'apps/legacy'), { catalog: { jquery: '3.0.0' } })
    writeJsonObject(join(FIXTURE_DIR, 'apps/frontend'), { catalog: { react: '19.0.0' } })

    const result = await discoverCatalogLocations({ cwd: FIXTURE_DIR, excludePatterns: ['apps/legacy'] })
    expect(result.map((l) => l.dir)).toEqual(['.', 'apps/frontend'])
  })

  test('excludes with glob pattern', async () => {
    writeJsonObject(join(FIXTURE_DIR, 'apps/frontend'), { catalog: { react: '19.0.0' } })
    writeJsonObject(join(FIXTURE_DIR, 'apps/old-api'), { catalog: { express: '4.0.0' } })
    writeJsonObject(join(FIXTURE_DIR, 'apps/old-web'), { catalog: { jquery: '3.0.0' } })

    const result = await discoverCatalogLocations({ cwd: FIXTURE_DIR, excludePatterns: ['apps/old-*'] })
    expect(result.map((l) => l.dir)).toEqual(['apps/frontend'])
  })

  test('returns empty array when no catalogs found', async () => {
    writeJsonObject(FIXTURE_DIR, { name: 'root' })

    const result = await discoverCatalogLocations({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result).toEqual([])
  })

  test('skips dotfile directories', async () => {
    writeJsonObject(FIXTURE_DIR, { catalog: { react: '19.0.0' } })
    writeJsonObject(join(FIXTURE_DIR, '.github'), { catalog: { actions: '1.0.0' } })
    writeText(join(FIXTURE_DIR, '.yarn'), '.yarnrc.yml', 'catalog:\n  react: ^19.0.0\n')

    const result = await discoverCatalogLocations({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result.map((l) => l.dir)).toEqual(['.'])
  })

  test('skips catalog with array value (invalid)', async () => {
    writeJsonObject(FIXTURE_DIR, { catalog: ['react', 'vue'] })

    const result = await discoverCatalogLocations({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result).toEqual([])
  })

  test('skips invalid YAML instead of throwing', async () => {
    writeText(FIXTURE_DIR, 'pnpm-workspace.yaml', 'catalog: [unclosed\n  bad yaml: :')

    const result = await discoverCatalogLocations({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result).toEqual([])
  })

  test('finds bun catalogs nested under workspaces', async () => {
    writeJsonObject(FIXTURE_DIR, {
      workspaces: { packages: ['packages/*'], catalog: { react: '19.0.0' } }
    })

    const result = await discoverCatalogLocations({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result).toHaveLength(1)
    expect(result[0]?.definition).toEqual({
      catalogName: 'default',
      entries: { react: '19.0.0' }
    })
  })
})
