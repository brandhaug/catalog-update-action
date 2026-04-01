import { describe, expect, test } from 'bun:test'
import { filterByReleaseAge, getVersionAgeDays } from '../src/registry'
import type { PackageMetadata, UpdateCandidate } from '../src/types'

const NOW = new Date('2026-03-31T12:00:00.000Z')

function makeCandidate(overrides: Partial<UpdateCandidate> & { name: string; latestVersion: string }): UpdateCandidate {
  return {
    raw: overrides.latestVersion,
    npmName: overrides.name,
    currentVersion: '1.0.0',
    hasCaret: false,
    isAlias: false,
    aliasName: null,
    changeType: 'minor',
    ...overrides
  }
}

function makeMetadata(versions: Record<string, string>): PackageMetadata {
  return {
    repo: { owner: 'test', repo: 'test' },
    publishedVersions: Object.keys(versions),
    publishTimes: versions
  }
}

describe('getVersionAgeDays', () => {
  test('returns age in days', () => {
    const age = getVersionAgeDays({
      publishTime: '2026-03-28T12:00:00.000Z',
      now: NOW
    })
    expect(age).toBe(3)
  })

  test('returns fractional days', () => {
    const age = getVersionAgeDays({
      publishTime: '2026-03-31T00:00:00.000Z',
      now: NOW
    })
    expect(age).toBe(0.5)
  })

  test('returns null for invalid date', () => {
    const age = getVersionAgeDays({ publishTime: 'not-a-date', now: NOW })
    expect(age).toBeNull()
  })
})

describe('filterByReleaseAge', () => {
  test('returns all candidates when minReleaseAgeDays is 0', () => {
    const candidates = [makeCandidate({ name: 'react', latestVersion: '2.0.0' })]
    const result = filterByReleaseAge({
      candidates,
      packageMetadata: new Map(),
      minReleaseAgeDays: 0,
      now: NOW
    })
    expect(result).toEqual(candidates)
  })

  test('keeps candidate when version is old enough', () => {
    const candidates = [makeCandidate({ name: 'react', latestVersion: '2.0.0' })]
    const metadata = new Map([
      ['react', makeMetadata({ '1.0.0': '2025-01-01T00:00:00.000Z', '2.0.0': '2026-03-25T12:00:00.000Z' })]
    ])

    const result = filterByReleaseAge({
      candidates,
      packageMetadata: metadata,
      minReleaseAgeDays: 3,
      now: NOW
    })

    expect(result).toHaveLength(1)
    expect(result[0]!.latestVersion).toBe('2.0.0')
  })

  test('removes candidate when no version qualifies', () => {
    const candidates = [makeCandidate({ name: 'react', latestVersion: '2.0.0' })]
    const metadata = new Map([
      ['react', makeMetadata({ '1.0.0': '2025-01-01T00:00:00.000Z', '2.0.0': '2026-03-31T00:00:00.000Z' })]
    ])

    const result = filterByReleaseAge({
      candidates,
      packageMetadata: metadata,
      minReleaseAgeDays: 3,
      now: NOW
    })

    expect(result).toHaveLength(0)
  })

  test('falls back to older qualifying version when latest is too young', () => {
    const candidates = [makeCandidate({ name: 'react', latestVersion: '2.1.0', currentVersion: '1.0.0' })]
    const metadata = new Map([
      ['react', makeMetadata({
        '1.0.0': '2025-01-01T00:00:00.000Z',
        '2.0.0': '2026-03-20T12:00:00.000Z',
        '2.1.0': '2026-03-31T00:00:00.000Z'
      })]
    ])

    const result = filterByReleaseAge({
      candidates,
      packageMetadata: metadata,
      minReleaseAgeDays: 3,
      now: NOW
    })

    expect(result).toHaveLength(1)
    expect(result[0]!.latestVersion).toBe('2.0.0')
    expect(result[0]!.changeType).toBe('major')
  })

  test('picks the newest qualifying fallback version', () => {
    const candidates = [makeCandidate({ name: 'lib', latestVersion: '1.3.0', currentVersion: '1.0.0' })]
    const metadata = new Map([
      ['lib', makeMetadata({
        '1.0.0': '2025-01-01T00:00:00.000Z',
        '1.1.0': '2026-03-10T00:00:00.000Z',
        '1.2.0': '2026-03-20T00:00:00.000Z',
        '1.3.0': '2026-03-31T00:00:00.000Z'
      })]
    ])

    const result = filterByReleaseAge({
      candidates,
      packageMetadata: metadata,
      minReleaseAgeDays: 3,
      now: NOW
    })

    expect(result).toHaveLength(1)
    expect(result[0]!.latestVersion).toBe('1.2.0')
  })

  test('allows candidate when no metadata available', () => {
    const candidates = [makeCandidate({ name: 'unknown-pkg', latestVersion: '2.0.0' })]

    const result = filterByReleaseAge({
      candidates,
      packageMetadata: new Map(),
      minReleaseAgeDays: 3,
      now: NOW
    })

    expect(result).toHaveLength(1)
  })

  test('allows candidate when publish time is unparseable', () => {
    const candidates = [makeCandidate({ name: 'react', latestVersion: '2.0.0' })]
    const metadata = new Map([
      ['react', makeMetadata({ '1.0.0': '2025-01-01T00:00:00.000Z', '2.0.0': 'not-a-date' })]
    ])

    const result = filterByReleaseAge({
      candidates,
      packageMetadata: metadata,
      minReleaseAgeDays: 3,
      now: NOW
    })

    expect(result).toHaveLength(1)
  })

  test('allows candidate when publish time is missing for the version', () => {
    const candidates = [makeCandidate({ name: 'react', latestVersion: '2.0.0' })]
    const metadata = new Map([
      ['react', makeMetadata({ '1.0.0': '2025-01-01T00:00:00.000Z' })]
    ])

    const result = filterByReleaseAge({
      candidates,
      packageMetadata: metadata,
      minReleaseAgeDays: 3,
      now: NOW
    })

    expect(result).toHaveLength(1)
  })

  test('skips pre-release fallback versions for stable current', () => {
    const candidates = [makeCandidate({ name: 'lib', latestVersion: '2.0.0', currentVersion: '1.0.0' })]
    const metadata = new Map([
      ['lib', makeMetadata({
        '1.0.0': '2025-01-01T00:00:00.000Z',
        '2.0.0-beta.1': '2026-03-10T00:00:00.000Z',
        '2.0.0': '2026-03-31T00:00:00.000Z'
      })]
    ])

    const result = filterByReleaseAge({
      candidates,
      packageMetadata: metadata,
      minReleaseAgeDays: 3,
      now: NOW
    })

    // 2.0.0-beta.1 should not be considered as fallback for stable current
    expect(result).toHaveLength(0)
  })

  test('considers pre-release fallback versions for pre-release current', () => {
    const candidates = [makeCandidate({
      name: 'lib',
      latestVersion: '2.0.0-rc.2',
      currentVersion: '2.0.0-beta.1',
      changeType: 'prerelease'
    })]
    const metadata = new Map([
      ['lib', makeMetadata({
        '2.0.0-beta.1': '2025-01-01T00:00:00.000Z',
        '2.0.0-rc.1': '2026-03-10T00:00:00.000Z',
        '2.0.0-rc.2': '2026-03-31T00:00:00.000Z'
      })]
    ])

    const result = filterByReleaseAge({
      candidates,
      packageMetadata: metadata,
      minReleaseAgeDays: 3,
      now: NOW
    })

    expect(result).toHaveLength(1)
    expect(result[0]!.latestVersion).toBe('2.0.0-rc.1')
  })

  test('handles multiple candidates independently', () => {
    const candidates = [
      makeCandidate({ name: 'old-pkg', latestVersion: '2.0.0' }),
      makeCandidate({ name: 'new-pkg', latestVersion: '3.0.0' })
    ]
    const metadata = new Map([
      ['old-pkg', makeMetadata({ '1.0.0': '2025-01-01T00:00:00.000Z', '2.0.0': '2026-03-20T00:00:00.000Z' })],
      ['new-pkg', makeMetadata({ '1.0.0': '2025-01-01T00:00:00.000Z', '3.0.0': '2026-03-31T00:00:00.000Z' })]
    ])

    const result = filterByReleaseAge({
      candidates,
      packageMetadata: metadata,
      minReleaseAgeDays: 3,
      now: NOW
    })

    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('old-pkg')
  })

  test('enforces age filter when metadata has no repo (repo: null)', () => {
    const candidates = [makeCandidate({ name: 'no-repo-pkg', latestVersion: '2.0.0' })]
    const metadata = new Map<string, PackageMetadata>([
      ['no-repo-pkg', {
        repo: null,
        publishedVersions: ['1.0.0', '2.0.0'],
        publishTimes: { '1.0.0': '2025-01-01T00:00:00.000Z', '2.0.0': '2026-03-31T00:00:00.000Z' }
      }]
    ])

    const result = filterByReleaseAge({
      candidates,
      packageMetadata: metadata,
      minReleaseAgeDays: 3,
      now: NOW
    })

    expect(result).toHaveLength(0)
  })

  test('updates changeType when falling back to a different version', () => {
    const candidates = [makeCandidate({
      name: 'lib',
      latestVersion: '2.0.0',
      currentVersion: '1.0.0',
      changeType: 'major'
    })]
    const metadata = new Map([
      ['lib', makeMetadata({
        '1.0.0': '2025-01-01T00:00:00.000Z',
        '1.1.0': '2026-03-10T00:00:00.000Z',
        '2.0.0': '2026-03-31T00:00:00.000Z'
      })]
    ])

    const result = filterByReleaseAge({
      candidates,
      packageMetadata: metadata,
      minReleaseAgeDays: 3,
      now: NOW
    })

    expect(result).toHaveLength(1)
    expect(result[0]!.latestVersion).toBe('1.1.0')
    expect(result[0]!.changeType).toBe('minor')
  })
})
