import { afterEach, describe, expect, test } from 'bun:test'
import { loadConfig } from '../src/config'
import { join } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

let tempDir: string | null = null

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true })
    tempDir = null
  }
})

async function writeTempConfig(content: string): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'catalog-update-test-'))
  const configPath = join(tempDir, '.catalog-updaterc.json')
  await writeFile(configPath, content)
  return configPath
}

describe('loadConfig', () => {
  test('returns defaults when file does not exist', async () => {
    const config = await loadConfig({ configPath: '/nonexistent/.catalog-updaterc.json' })

    expect(config.branchPrefix).toBe('catalog-update')
    expect(config.defaultBranch).toBe('master')
    expect(config.maxOpenPrs).toBe(20)
    expect(config.concurrency).toBe(10)
    expect(config.packageManager).toBe('bun')
    expect(config.groups).toEqual([])
    expect(config.ignore).toEqual([])
  })

  test('loads valid config', async () => {
    const configPath = await writeTempConfig(JSON.stringify({
      branchPrefix: 'deps',
      defaultBranch: 'main',
      maxOpenPrs: 10,
      concurrency: 5,
      packageManager: 'pnpm',
      groups: [
        { name: 'react', patterns: ['react', 'react-dom'] },
        { name: 'patches', patterns: ['*'], updateTypes: ['patch'] }
      ],
      ignore: [
        { pattern: 'typescript', updateTypes: ['major'] }
      ]
    }))

    const config = await loadConfig({ configPath })

    expect(config.branchPrefix).toBe('deps')
    expect(config.defaultBranch).toBe('main')
    expect(config.maxOpenPrs).toBe(10)
    expect(config.concurrency).toBe(5)
    expect(config.packageManager).toBe('pnpm')
    expect(config.groups).toHaveLength(2)
    expect(config.groups[0]).toEqual({ name: 'react', patterns: ['react', 'react-dom'], updateTypes: null })
    expect(config.groups[1]).toEqual({ name: 'patches', patterns: ['*'], updateTypes: ['patch'] })
    expect(config.ignore).toHaveLength(1)
    expect(config.ignore[0]).toEqual({ pattern: 'typescript', updateTypes: ['major'] })
  })

  test('uses defaults for missing fields', async () => {
    const configPath = await writeTempConfig(JSON.stringify({
      defaultBranch: 'main'
    }))

    const config = await loadConfig({ configPath })

    expect(config.branchPrefix).toBe('catalog-update')
    expect(config.defaultBranch).toBe('main')
    expect(config.maxOpenPrs).toBe(20)
    expect(config.groups).toEqual([])
  })

  test('rejects invalid packageManager', async () => {
    const configPath = await writeTempConfig(JSON.stringify({
      packageManager: 'deno'
    }))

    const config = await loadConfig({ configPath })

    expect(config.packageManager).toBe('bun')
  })

  test('filters invalid updateTypes', async () => {
    const configPath = await writeTempConfig(JSON.stringify({
      groups: [
        { name: 'test', patterns: ['*'], updateTypes: ['major', 'invalid', 'patch'] }
      ]
    }))

    const config = await loadConfig({ configPath })

    expect(config.groups[0]?.updateTypes).toEqual(['major', 'patch'])
  })

  test('skips groups with missing required fields', async () => {
    const configPath = await writeTempConfig(JSON.stringify({
      groups: [
        { name: 'valid', patterns: ['react'] },
        { name: 'no-patterns' },
        { patterns: ['missing-name'] },
        'not-an-object'
      ]
    }))

    const config = await loadConfig({ configPath })

    expect(config.groups).toHaveLength(1)
    expect(config.groups[0]?.name).toBe('valid')
  })
})
