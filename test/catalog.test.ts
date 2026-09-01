import { describe, expect, test } from 'bun:test'
import { parseCatalog, buildCatalogValue } from '../src/catalog'

describe('parseCatalog', () => {
  test('parses standard versions', () => {
    const entries = parseCatalog({
      catalog: {
        react: '19.0.0',
        lodash: '4.17.21'
      }
    })

    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      name: 'react',
      npmName: 'react',
      currentVersion: '19.0.0',
      rangePrefix: "",
      isAlias: false
    })
  })

  test('parses caret ranges', () => {
    const entries = parseCatalog({ catalog: { react: '^19.0.0' } })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      name: 'react',
      currentVersion: '19.0.0',
      rangePrefix: "^"
    })
  })

  test('parses tilde ranges', () => {
    const entries = parseCatalog({ catalog: { lodash: '~4.17.0' } })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      name: 'lodash',
      currentVersion: '4.17.0',
      rangePrefix: "~"
    })
  })

  test('parses npm: aliases', () => {
    const entries = parseCatalog({ catalog: { vite: 'npm:rolldown-vite@7.3.1' } })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      name: 'vite',
      npmName: 'rolldown-vite',
      currentVersion: '7.3.1',
      rangePrefix: "",
      isAlias: true
    })
  })

  test('parses npm: aliases with caret', () => {
    const entries = parseCatalog({ catalog: { vite: 'npm:rolldown-vite@^7.3.1' } })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      npmName: 'rolldown-vite',
      currentVersion: '7.3.1',
      rangePrefix: "^",
      isAlias: true
    })
  })

  test('parses npm: aliases with tilde', () => {
    const entries = parseCatalog({ catalog: { vite: 'npm:rolldown-vite@~7.3.1' } })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      npmName: 'rolldown-vite',
      currentVersion: '7.3.1',
      rangePrefix: "~",
      isAlias: true
    })
  })

  test('includes pre-release versions', () => {
    const entries = parseCatalog({
      catalog: {
        '@typescript/native-preview': '7.0.0-dev.123',
        'some-beta': '1.0.0-beta.1',
        'some-rc': '2.0.0-rc.3',
        react: '19.0.0'
      }
    })

    expect(entries).toHaveLength(4)
    expect(entries.map((e) => e.name)).toEqual([
      '@typescript/native-preview',
      'some-beta',
      'some-rc',
      'react'
    ])
  })

  test('skips invalid semver', () => {
    const entries = parseCatalog({
      catalog: {
        'not-semver': 'latest',
        'also-not': 'workspace:*',
        react: '19.0.0'
      }
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('react')
  })

  test('handles empty catalog', () => {
    const entries = parseCatalog({ catalog: {} })
    expect(entries).toHaveLength(0)
  })

  test('handles scoped packages', () => {
    const entries = parseCatalog({ catalog: { '@sentry/react': '^8.0.0' } })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      name: '@sentry/react',
      npmName: '@sentry/react',
      currentVersion: '8.0.0',
      rangePrefix: "^"
    })
  })
})

describe('buildCatalogValue', () => {
  test('returns plain version for non-caret, non-alias', () => {
    const result = buildCatalogValue({
      update: {
        name: 'react',
        npmName: 'react',
        currentVersion: '18.0.0',
        latestVersion: '19.1.0',
        changeType: 'major',
        rangePrefix: "",
        isAlias: false
      }
    })
    expect(result).toBe('19.1.0')
  })

  test('returns caret version', () => {
    const result = buildCatalogValue({
      update: {
        name: 'react',
        npmName: 'react',
        currentVersion: '18.0.0',
        latestVersion: '19.1.0',
        changeType: 'major',
        rangePrefix: "^",
        isAlias: false
      }
    })
    expect(result).toBe('^19.1.0')
  })

  test('returns tilde version', () => {
    const result = buildCatalogValue({
      update: {
        name: 'lodash',
        npmName: 'lodash',
        currentVersion: '4.17.0',
        latestVersion: '4.18.0',
        changeType: 'minor',
        rangePrefix: "~",
        isAlias: false
      }
    })
    expect(result).toBe('~4.18.0')
  })

  test('returns npm: alias format', () => {
    const result = buildCatalogValue({
      update: {
        name: 'vite',
        npmName: 'rolldown-vite',
        currentVersion: '7.3.1',
        latestVersion: '7.4.0',
        changeType: 'minor',
        rangePrefix: "",
        isAlias: true
      }
    })
    expect(result).toBe('npm:rolldown-vite@7.4.0')
  })

  test('returns npm: alias format with caret', () => {
    const result = buildCatalogValue({
      update: {
        name: 'vite',
        npmName: 'rolldown-vite',
        currentVersion: '7.3.1',
        latestVersion: '7.4.0',
        changeType: 'minor',
        rangePrefix: "^",
        isAlias: true
      }
    })
    expect(result).toBe('npm:rolldown-vite@^7.4.0')
  })
})
