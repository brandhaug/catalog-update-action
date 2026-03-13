import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { discoverCatalogDirectories } from '../src/discover'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'

const FIXTURE_DIR = join(import.meta.dir, '.fixtures-discover')

async function writePackageJson(dir: string, content: Record<string, unknown>): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await Bun.write(join(dir, 'package.json'), JSON.stringify(content, null, 2))
}

beforeEach(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
})

describe('discoverCatalogDirectories', () => {
  test('finds root catalog', async () => {
    await writePackageJson(FIXTURE_DIR, { catalog: { react: '19.0.0' } })

    const result = await discoverCatalogDirectories({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result).toEqual(['.'])
  })

  test('finds nested catalogs', async () => {
    await writePackageJson(join(FIXTURE_DIR, 'apps/frontend'), { catalog: { react: '19.0.0' } })
    await writePackageJson(join(FIXTURE_DIR, 'apps/backend'), { catalog: { express: '5.0.0' } })

    const result = await discoverCatalogDirectories({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result).toEqual(['apps/backend', 'apps/frontend'])
  })

  test('skips package.json without catalog', async () => {
    await writePackageJson(FIXTURE_DIR, { name: 'root', dependencies: { react: '19.0.0' } })
    await writePackageJson(join(FIXTURE_DIR, 'apps/frontend'), { catalog: { react: '19.0.0' } })

    const result = await discoverCatalogDirectories({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result).toEqual(['apps/frontend'])
  })

  test('skips node_modules', async () => {
    await writePackageJson(FIXTURE_DIR, { catalog: { react: '19.0.0' } })
    await writePackageJson(join(FIXTURE_DIR, 'node_modules/react'), { catalog: { scheduler: '1.0.0' } })

    const result = await discoverCatalogDirectories({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result).toEqual(['.'])
  })

  test('excludes exact directory', async () => {
    await writePackageJson(FIXTURE_DIR, { catalog: { react: '19.0.0' } })
    await writePackageJson(join(FIXTURE_DIR, 'apps/legacy'), { catalog: { jquery: '3.0.0' } })
    await writePackageJson(join(FIXTURE_DIR, 'apps/frontend'), { catalog: { react: '19.0.0' } })

    const result = await discoverCatalogDirectories({ cwd: FIXTURE_DIR, excludePatterns: ['apps/legacy'] })
    expect(result).toEqual(['.', 'apps/frontend'])
  })

  test('excludes with glob pattern', async () => {
    await writePackageJson(join(FIXTURE_DIR, 'apps/frontend'), { catalog: { react: '19.0.0' } })
    await writePackageJson(join(FIXTURE_DIR, 'apps/old-api'), { catalog: { express: '4.0.0' } })
    await writePackageJson(join(FIXTURE_DIR, 'apps/old-web'), { catalog: { jquery: '3.0.0' } })

    const result = await discoverCatalogDirectories({ cwd: FIXTURE_DIR, excludePatterns: ['apps/old-*'] })
    expect(result).toEqual(['apps/frontend'])
  })

  test('returns empty array when no catalogs found', async () => {
    await writePackageJson(FIXTURE_DIR, { name: 'root' })

    const result = await discoverCatalogDirectories({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result).toEqual([])
  })

  test('finds mixed root and nested catalogs', async () => {
    await writePackageJson(FIXTURE_DIR, { catalog: { typescript: '5.0.0' } })
    await writePackageJson(join(FIXTURE_DIR, 'packages/core'), { catalog: { zod: '3.0.0' } })

    const result = await discoverCatalogDirectories({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result).toEqual(['.', 'packages/core'])
  })

  test('skips dotfile directories', async () => {
    await writePackageJson(FIXTURE_DIR, { catalog: { react: '19.0.0' } })
    await writePackageJson(join(FIXTURE_DIR, '.github'), { catalog: { actions: '1.0.0' } })
    await writePackageJson(join(FIXTURE_DIR, '.devcontainer'), { catalog: { devtools: '2.0.0' } })

    const result = await discoverCatalogDirectories({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result).toEqual(['.'])
  })

  test('skips catalog with array value (invalid)', async () => {
    await writePackageJson(FIXTURE_DIR, { catalog: ['react', 'vue'] })

    const result = await discoverCatalogDirectories({ cwd: FIXTURE_DIR, excludePatterns: [] })
    expect(result).toEqual([])
  })
})
