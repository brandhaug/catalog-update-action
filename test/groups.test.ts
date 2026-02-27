import { describe, expect, test } from 'bun:test'
import { assignToGroups, shouldIgnore } from '../src/groups'
import type { UpdateCandidate } from '../src/types'

function makeCandidate(overrides: Partial<UpdateCandidate> & { name: string; changeType: UpdateCandidate['changeType'] }): UpdateCandidate {
  return {
    raw: overrides.name,
    npmName: overrides.name,
    currentVersion: '1.0.0',
    latestVersion: '2.0.0',
    hasCaret: false,
    isAlias: false,
    aliasName: null,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// shouldIgnore
// ---------------------------------------------------------------------------

describe('shouldIgnore', () => {
  test('ignores matching pattern with matching update type', () => {
    const result = shouldIgnore({
      name: '@storybook/react',
      changeType: 'major',
      rules: [{ pattern: '*storybook*', updateTypes: ['major'] }]
    })
    expect(result).toBe(true)
  })

  test('does not ignore non-matching update type', () => {
    const result = shouldIgnore({
      name: '@storybook/react',
      changeType: 'patch',
      rules: [{ pattern: '*storybook*', updateTypes: ['major'] }]
    })
    expect(result).toBe(false)
  })

  test('ignores all update types when updateTypes is null', () => {
    const result = shouldIgnore({
      name: 'typescript',
      changeType: 'minor',
      rules: [{ pattern: 'typescript', updateTypes: null }]
    })
    expect(result).toBe(true)
  })

  test('does not ignore non-matching pattern', () => {
    const result = shouldIgnore({
      name: 'react',
      changeType: 'major',
      rules: [{ pattern: '*storybook*', updateTypes: ['major'] }]
    })
    expect(result).toBe(false)
  })

  test('returns false with empty rules', () => {
    const result = shouldIgnore({
      name: 'react',
      changeType: 'major',
      rules: []
    })
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// assignToGroups
// ---------------------------------------------------------------------------

describe('assignToGroups', () => {
  test('assigns candidates to matching groups', () => {
    const candidates = [
      makeCandidate({ name: 'react', changeType: 'minor' }),
      makeCandidate({ name: 'react-dom', changeType: 'minor' }),
      makeCandidate({ name: 'lodash-es', changeType: 'patch' })
    ]

    const result = assignToGroups({
      candidates,
      groups: [
        { name: 'react', patterns: ['react', 'react-dom'], updateTypes: null },
        { name: 'all-patch-updates', patterns: ['*'], updateTypes: ['patch'] }
      ]
    })

    expect(result.get('react')).toHaveLength(2)
    expect(result.get('all-patch-updates')).toHaveLength(1)
  })

  test('first match wins — does not double-assign', () => {
    const candidates = [
      makeCandidate({ name: 'react', changeType: 'minor' })
    ]

    const result = assignToGroups({
      candidates,
      groups: [
        { name: 'react', patterns: ['react'], updateTypes: null },
        { name: 'catch-all', patterns: ['*'], updateTypes: null }
      ]
    })

    expect(result.get('react')).toHaveLength(1)
    expect(result.has('catch-all')).toBe(false)
  })

  test('respects updateTypes filter', () => {
    const candidates = [
      makeCandidate({ name: 'lodash-es', changeType: 'major' }),
      makeCandidate({ name: 'date-fns', changeType: 'patch' })
    ]

    const result = assignToGroups({
      candidates,
      groups: [
        { name: 'all-patch-updates', patterns: ['*'], updateTypes: ['patch'] }
      ]
    })

    expect(result.get('all-patch-updates')).toHaveLength(1)
    expect(result.get('all-patch-updates')?.[0]?.name).toBe('date-fns')
  })

  test('collapses patch-only groups into all-patch-updates', () => {
    const candidates = [
      makeCandidate({ name: '@sentry/react', changeType: 'patch' }),
      makeCandidate({ name: '@sentry/browser', changeType: 'patch' }),
      makeCandidate({ name: 'lodash-es', changeType: 'patch' })
    ]

    const result = assignToGroups({
      candidates,
      groups: [
        { name: 'sentry', patterns: ['@sentry/*'], updateTypes: null },
        { name: 'all-patch-updates', patterns: ['*'], updateTypes: ['patch'] }
      ]
    })

    // sentry group should be collapsed since it only has patches
    expect(result.has('sentry')).toBe(false)
    expect(result.get('all-patch-updates')).toHaveLength(3)
  })

  test('does not collapse groups with major or minor updates', () => {
    const candidates = [
      makeCandidate({ name: '@sentry/react', changeType: 'minor' }),
      makeCandidate({ name: '@sentry/browser', changeType: 'patch' }),
      makeCandidate({ name: 'lodash-es', changeType: 'patch' })
    ]

    const result = assignToGroups({
      candidates,
      groups: [
        { name: 'sentry', patterns: ['@sentry/*'], updateTypes: null },
        { name: 'all-patch-updates', patterns: ['*'], updateTypes: ['patch'] }
      ]
    })

    expect(result.get('sentry')).toHaveLength(2)
    expect(result.get('all-patch-updates')).toHaveLength(1)
  })

  test('handles empty candidates', () => {
    const result = assignToGroups({
      candidates: [],
      groups: [{ name: 'react', patterns: ['react'], updateTypes: null }]
    })

    expect(result.size).toBe(0)
  })

  test('handles empty groups', () => {
    const candidates = [makeCandidate({ name: 'react', changeType: 'minor' })]

    const result = assignToGroups({ candidates, groups: [] })

    expect(result.size).toBe(0)
  })
})
