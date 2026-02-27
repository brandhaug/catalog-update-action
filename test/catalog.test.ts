import { describe, expect, test } from 'bun:test'
import { parseCatalog } from '../src/catalog'

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
      raw: '19.0.0',
      npmName: 'react',
      currentVersion: '19.0.0',
      hasCaret: false,
      isAlias: false,
      aliasName: null
    })
  })

  test('parses caret ranges', () => {
    const entries = parseCatalog({ catalog: { react: '^19.0.0' } })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      name: 'react',
      currentVersion: '19.0.0',
      hasCaret: true
    })
  })

  test('parses npm: aliases', () => {
    const entries = parseCatalog({ catalog: { vite: 'npm:rolldown-vite@7.3.1' } })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      name: 'vite',
      raw: 'npm:rolldown-vite@7.3.1',
      npmName: 'rolldown-vite',
      currentVersion: '7.3.1',
      hasCaret: false,
      isAlias: true,
      aliasName: 'rolldown-vite'
    })
  })

  test('parses npm: aliases with caret', () => {
    const entries = parseCatalog({ catalog: { vite: 'npm:rolldown-vite@^7.3.1' } })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      npmName: 'rolldown-vite',
      currentVersion: '7.3.1',
      hasCaret: true,
      isAlias: true
    })
  })

  test('skips pre-release versions', () => {
    const entries = parseCatalog({
      catalog: {
        '@typescript/native-preview': '7.0.0-dev.123',
        'some-beta': '1.0.0-beta.1',
        'some-rc': '2.0.0-rc.3',
        react: '19.0.0'
      }
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('react')
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
      hasCaret: true
    })
  })
})
