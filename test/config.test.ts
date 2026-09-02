import { afterEach, describe, expect, test } from 'bun:test'
import { Effect, Layer, Logger } from 'effect'
import { BunFileSystem } from '@effect/platform-bun'
import { type Config } from '../src/types'
import { loadConfig, parseAuditConfig, parseAutoMergeConfig } from '../src/config'
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

/** Run loadConfig against the real Bun filesystem, collecting log output. */
async function runLoadConfig(
  configPath: string
): Promise<{ config: Config; messages: Array<string> }> {
  const messages: Array<string> = []
  const captureLayer = Logger.layer([
    Logger.make((options) => {
      const parts = Array.isArray(options.message)
        ? options.message.map(String)
        : [String(options.message)]
      messages.push(parts.join(' '))
    })
  ])
  const config = await Effect.runPromise(
    loadConfig({ configPath }).pipe(
      Effect.provide(Layer.mergeAll(BunFileSystem.layer, captureLayer))
    )
  )
  return { config, messages }
}

describe('loadConfig', () => {
  test('returns defaults when file does not exist', async () => {
    const { config } = await runLoadConfig('/nonexistent/.catalog-updaterc.json')

    expect(config.branchPrefix).toBe('catalog-update')
    expect(config.defaultBranch).toBe('master')
    expect(config.maxOpenPrs).toBe(20)
    expect(config.concurrency).toBe(10)
    expect(config.minReleaseAgeDays).toBe(0)
    expect(config.groups).toEqual([])
    expect(config.ignore).toEqual([])
    expect(config.audit).toEqual({ enabled: true, minimumSeverity: 'moderate' })
  })

  test('loads valid config', async () => {
    const configPath = await writeTempConfig(JSON.stringify({
      branchPrefix: 'deps',
      defaultBranch: 'main',
      maxOpenPrs: 10,
      concurrency: 5,
      groups: [
        { name: 'react', patterns: ['react', 'react-dom'] },
        { name: 'patches', patterns: ['*'], updateTypes: ['patch'] }
      ],
      ignore: [
        { pattern: 'typescript', updateTypes: ['major'] }
      ]
    }))

    const { config } = await runLoadConfig(configPath)

    expect(config.branchPrefix).toBe('deps')
    expect(config.defaultBranch).toBe('main')
    expect(config.maxOpenPrs).toBe(10)
    expect(config.concurrency).toBe(5)
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

    const { config } = await runLoadConfig(configPath)

    expect(config.branchPrefix).toBe('catalog-update')
    expect(config.defaultBranch).toBe('main')
    expect(config.maxOpenPrs).toBe(20)
    expect(config.groups).toEqual([])
  })

  test('warns about deprecated packageManager option but keeps loading', async () => {
    const configPath = await writeTempConfig(JSON.stringify({
      packageManager: 'pnpm',
      defaultBranch: 'main'
    }))

    const { config, messages } = await runLoadConfig(configPath)

    expect(config.defaultBranch).toBe('main')
    expect(messages.some((w) => w.includes('packageManager'))).toBe(true)
  })

  test('filters invalid updateTypes', async () => {
    const configPath = await writeTempConfig(JSON.stringify({
      groups: [
        { name: 'test', patterns: ['*'], updateTypes: ['major', 'invalid', 'patch'] }
      ]
    }))

    const { config } = await runLoadConfig(configPath)

    expect(config.groups[0]?.updateTypes).toEqual(['major', 'patch'])
  })

  test('accepts prerelease as valid update type', async () => {
    const configPath = await writeTempConfig(JSON.stringify({
      groups: [
        { name: 'test', patterns: ['*'], updateTypes: ['prerelease', 'patch'] }
      ]
    }))

    const { config } = await runLoadConfig(configPath)

    expect(config.groups[0]?.updateTypes).toEqual(['prerelease', 'patch'])
  })

  test('accepts release as valid update type', async () => {
    const configPath = await writeTempConfig(JSON.stringify({
      groups: [
        { name: 'test', patterns: ['*'], updateTypes: ['release', 'patch'] }
      ]
    }))

    const { config } = await runLoadConfig(configPath)

    expect(config.groups[0]?.updateTypes).toEqual(['release', 'patch'])
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

    const { config } = await runLoadConfig(configPath)

    expect(config.groups).toHaveLength(1)
    expect(config.groups[0]?.name).toBe('valid')
  })

  test('loads audit config', async () => {
    const configPath = await writeTempConfig(JSON.stringify({
      audit: { enabled: true, minimumSeverity: 'high' }
    }))

    const { config } = await runLoadConfig(configPath)

    expect(config.audit.enabled).toBe(true)
    expect(config.audit.minimumSeverity).toBe('high')
  })

  test('uses audit defaults for missing fields', async () => {
    const configPath = await writeTempConfig(JSON.stringify({
      audit: { enabled: true }
    }))

    const { config } = await runLoadConfig(configPath)

    expect(config.audit.enabled).toBe(true)
    expect(config.audit.minimumSeverity).toBe('moderate')
  })

  test('loads minReleaseAgeDays', async () => {
    const configPath = await writeTempConfig(JSON.stringify({
      minReleaseAgeDays: 7
    }))

    const { config } = await runLoadConfig(configPath)

    expect(config.minReleaseAgeDays).toBe(7)
  })

  test('defaults minReleaseAgeDays to 0 when missing', async () => {
    const configPath = await writeTempConfig(JSON.stringify({}))

    const { config } = await runLoadConfig(configPath)

    expect(config.minReleaseAgeDays).toBe(0)
  })

  test('rejects negative minReleaseAgeDays', async () => {
    const configPath = await writeTempConfig(JSON.stringify({
      minReleaseAgeDays: -5
    }))

    const { config } = await runLoadConfig(configPath)

    expect(config.minReleaseAgeDays).toBe(0)
  })

  test('rejects float minReleaseAgeDays', async () => {
    const configPath = await writeTempConfig(JSON.stringify({
      minReleaseAgeDays: 3.5
    }))

    const { config } = await runLoadConfig(configPath)

    expect(config.minReleaseAgeDays).toBe(0)
  })

  test('rejects non-number minReleaseAgeDays', async () => {
    const configPath = await writeTempConfig(JSON.stringify({
      minReleaseAgeDays: 'three'
    }))

    const { config } = await runLoadConfig(configPath)

    expect(config.minReleaseAgeDays).toBe(0)
  })
})

describe('parseAutoMergeConfig', () => {
  test('defaults to disabled with squash', () => {
    expect(parseAutoMergeConfig({ raw: null })).toEqual({ enabled: false, mergeMethod: 'squash' })
    expect(parseAutoMergeConfig({ raw: undefined })).toEqual({ enabled: false, mergeMethod: 'squash' })
    expect(parseAutoMergeConfig({ raw: 'string' })).toEqual({ enabled: false, mergeMethod: 'squash' })
  })

  test('parses a valid config', () => {
    expect(parseAutoMergeConfig({ raw: { enabled: true, mergeMethod: 'rebase' } })).toEqual({
      enabled: true,
      mergeMethod: 'rebase'
    })
  })

  test('falls back to squash for an unknown merge method', () => {
    expect(parseAutoMergeConfig({ raw: { enabled: true, mergeMethod: 'fast-forward' } })).toEqual({
      enabled: true,
      mergeMethod: 'squash'
    })
  })

  test('ignores a non-boolean enabled', () => {
    expect(parseAutoMergeConfig({ raw: { enabled: 'yes' } })).toEqual({
      enabled: false,
      mergeMethod: 'squash'
    })
  })
})

describe('parseAuditConfig', () => {
  test('returns defaults for null/undefined', () => {
    expect(parseAuditConfig({ raw: null })).toEqual({ enabled: true, minimumSeverity: 'moderate' })
    expect(parseAuditConfig({ raw: undefined })).toEqual({ enabled: true, minimumSeverity: 'moderate' })
  })

  test('returns defaults for non-object', () => {
    expect(parseAuditConfig({ raw: 'string' })).toEqual({ enabled: true, minimumSeverity: 'moderate' })
  })

  test('parses valid config', () => {
    expect(parseAuditConfig({ raw: { enabled: true, minimumSeverity: 'critical' } })).toEqual({
      enabled: true,
      minimumSeverity: 'critical'
    })
  })

  test('falls back to default for invalid severity', () => {
    expect(parseAuditConfig({ raw: { enabled: true, minimumSeverity: 'invalid' } })).toEqual({
      enabled: true,
      minimumSeverity: 'moderate'
    })
  })
})
