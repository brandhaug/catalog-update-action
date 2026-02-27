import { describe, expect, test } from 'bun:test'
import {
  classifySemverChange,
  compareSemver,
  extractVersionFromTag,
  getIntermediateVersions,
  matchesAnyPattern,
  matchesGlob,
  parseSemver
} from '../src/utils'

// ---------------------------------------------------------------------------
// parseSemver
// ---------------------------------------------------------------------------

describe('parseSemver', () => {
  test('parses standard semver', () => {
    expect(parseSemver({ version: '1.2.3' })).toEqual({ major: 1, minor: 2, patch: 3 })
  })

  test('parses semver with pre-release suffix', () => {
    expect(parseSemver({ version: '1.2.3-beta.1' })).toEqual({ major: 1, minor: 2, patch: 3 })
  })

  test('returns null for invalid version', () => {
    expect(parseSemver({ version: 'not-a-version' })).toBeNull()
    expect(parseSemver({ version: '' })).toBeNull()
    expect(parseSemver({ version: '1.2' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// classifySemverChange
// ---------------------------------------------------------------------------

describe('classifySemverChange', () => {
  test('detects major change', () => {
    expect(classifySemverChange({ from: '1.0.0', to: '2.0.0' })).toBe('major')
    expect(classifySemverChange({ from: '1.5.3', to: '3.0.0' })).toBe('major')
  })

  test('detects minor change', () => {
    expect(classifySemverChange({ from: '1.0.0', to: '1.1.0' })).toBe('minor')
    expect(classifySemverChange({ from: '1.2.3', to: '1.5.0' })).toBe('minor')
  })

  test('detects patch change', () => {
    expect(classifySemverChange({ from: '1.0.0', to: '1.0.1' })).toBe('patch')
    expect(classifySemverChange({ from: '1.2.3', to: '1.2.9' })).toBe('patch')
  })

  test('returns null for equal versions', () => {
    expect(classifySemverChange({ from: '1.2.3', to: '1.2.3' })).toBeNull()
  })

  test('returns null for downgrade', () => {
    expect(classifySemverChange({ from: '2.0.0', to: '1.0.0' })).toBeNull()
    expect(classifySemverChange({ from: '1.5.0', to: '1.3.0' })).toBeNull()
    expect(classifySemverChange({ from: '1.0.5', to: '1.0.3' })).toBeNull()
  })

  test('returns null for invalid versions', () => {
    expect(classifySemverChange({ from: 'invalid', to: '1.0.0' })).toBeNull()
    expect(classifySemverChange({ from: '1.0.0', to: 'invalid' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------

describe('compareSemver', () => {
  test('returns negative when a < b', () => {
    expect(compareSemver({ a: '1.0.0', b: '2.0.0' })).toBeLessThan(0)
    expect(compareSemver({ a: '1.0.0', b: '1.1.0' })).toBeLessThan(0)
    expect(compareSemver({ a: '1.0.0', b: '1.0.1' })).toBeLessThan(0)
  })

  test('returns positive when a > b', () => {
    expect(compareSemver({ a: '2.0.0', b: '1.0.0' })).toBeGreaterThan(0)
    expect(compareSemver({ a: '1.1.0', b: '1.0.0' })).toBeGreaterThan(0)
    expect(compareSemver({ a: '1.0.1', b: '1.0.0' })).toBeGreaterThan(0)
  })

  test('returns 0 for equal versions', () => {
    expect(compareSemver({ a: '1.2.3', b: '1.2.3' })).toBe(0)
  })

  test('returns 0 for invalid versions', () => {
    expect(compareSemver({ a: 'bad', b: '1.0.0' })).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// matchesGlob
// ---------------------------------------------------------------------------

describe('matchesGlob', () => {
  test('matches exact names', () => {
    expect(matchesGlob({ name: 'react', pattern: 'react' })).toBe(true)
    expect(matchesGlob({ name: 'react', pattern: 'react-dom' })).toBe(false)
  })

  test('matches wildcard prefix', () => {
    expect(matchesGlob({ name: '@storybook/react', pattern: '*storybook*' })).toBe(true)
    expect(matchesGlob({ name: 'storybook', pattern: '*storybook*' })).toBe(true)
  })

  test('matches wildcard suffix', () => {
    expect(matchesGlob({ name: 'vite-plugin-react', pattern: 'vite*' })).toBe(true)
    expect(matchesGlob({ name: 'rolldown-vite', pattern: 'vite*' })).toBe(false)
  })

  test('matches scoped packages', () => {
    expect(matchesGlob({ name: '@vitejs/plugin-react', pattern: '@vitejs/*' })).toBe(true)
    expect(matchesGlob({ name: '@vitest/utils', pattern: '@vitejs/*' })).toBe(false)
  })

  test('matches catch-all', () => {
    expect(matchesGlob({ name: 'anything', pattern: '*' })).toBe(true)
    expect(matchesGlob({ name: '@scope/pkg', pattern: '*' })).toBe(true)
  })

  test('escapes regex special characters', () => {
    expect(matchesGlob({ name: 'foo.bar', pattern: 'foo.bar' })).toBe(true)
    expect(matchesGlob({ name: 'fooXbar', pattern: 'foo.bar' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// matchesAnyPattern
// ---------------------------------------------------------------------------

describe('matchesAnyPattern', () => {
  test('returns true if any pattern matches', () => {
    expect(matchesAnyPattern({ name: 'react', patterns: ['vue', 'react', 'angular'] })).toBe(true)
  })

  test('returns false if no patterns match', () => {
    expect(matchesAnyPattern({ name: 'react', patterns: ['vue', 'angular'] })).toBe(false)
  })

  test('works with glob patterns', () => {
    expect(matchesAnyPattern({ name: '@storybook/react', patterns: ['@storybook/*', 'storybook*'] })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// extractVersionFromTag
// ---------------------------------------------------------------------------

describe('extractVersionFromTag', () => {
  test('parses v-prefixed tag', () => {
    expect(extractVersionFromTag({ tag: 'v1.2.3' })).toBe('1.2.3')
  })

  test('parses plain version tag', () => {
    expect(extractVersionFromTag({ tag: '1.2.3' })).toBe('1.2.3')
  })

  test('parses scoped package tag', () => {
    expect(extractVersionFromTag({ tag: '@scope/name@1.2.3' })).toBe('1.2.3')
  })

  test('parses unscoped package tag', () => {
    expect(extractVersionFromTag({ tag: 'package-name@1.2.3' })).toBe('1.2.3')
  })

  test('returns null for invalid tag', () => {
    expect(extractVersionFromTag({ tag: 'not-a-version' })).toBeNull()
  })

  test('preserves pre-release suffix', () => {
    expect(extractVersionFromTag({ tag: 'v1.2.3-beta.1' })).toBe('1.2.3-beta.1')
  })
})

// ---------------------------------------------------------------------------
// getIntermediateVersions
// ---------------------------------------------------------------------------

describe('getIntermediateVersions', () => {
  test('returns versions between current and latest', () => {
    const result = getIntermediateVersions({
      publishedVersions: ['1.0.0', '1.1.0', '1.2.0', '1.3.0'],
      currentVersion: '1.0.0',
      latestVersion: '1.3.0'
    })
    expect(result).toEqual(['1.3.0', '1.2.0', '1.1.0'])
  })

  test('excludes pre-release versions', () => {
    const result = getIntermediateVersions({
      publishedVersions: ['1.0.0', '1.1.0-beta.1', '1.1.0', '1.2.0'],
      currentVersion: '1.0.0',
      latestVersion: '1.2.0'
    })
    expect(result).toEqual(['1.2.0', '1.1.0'])
  })

  test('respects maxVersions limit', () => {
    const result = getIntermediateVersions({
      publishedVersions: ['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4'],
      currentVersion: '1.0.0',
      latestVersion: '1.0.4',
      maxVersions: 2
    })
    expect(result).toEqual(['1.0.4', '1.0.3'])
  })

  test('falls back to latest when no intermediate versions found', () => {
    const result = getIntermediateVersions({
      publishedVersions: [],
      currentVersion: '1.0.0',
      latestVersion: '2.0.0'
    })
    expect(result).toEqual(['2.0.0'])
  })

  test('excludes current version', () => {
    const result = getIntermediateVersions({
      publishedVersions: ['1.0.0', '1.1.0'],
      currentVersion: '1.0.0',
      latestVersion: '1.1.0'
    })
    expect(result).toEqual(['1.1.0'])
    expect(result).not.toContain('1.0.0')
  })
})
