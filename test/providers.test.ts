import { describe, expect, test } from 'bun:test'
import { getProvider, PROVIDERS, type ProviderId } from '../src/providers'
import { type OverrideEntry, type UpdateCandidate } from '../src/types'

function makeCandidate(overrides: Partial<UpdateCandidate> & { name: string }): UpdateCandidate {
  return {
    npmName: overrides.name,
    currentVersion: '1.0.0',
    latestVersion: '2.0.0',
    changeType: 'major',
    rangePrefix: "",
    isAlias: false,
    ...overrides
  }
}

function makeAdvisory(): OverrideEntry['advisories'][number] {
  return {
    id: 1234,
    url: 'https://github.com/advisories/GHSA-1234',
    title: 'Test Advisory',
    severity: 'high',
    vulnerable_versions: '<1.0.0',
    cwe: ['CWE-79'],
    cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N' }
  }
}

describe('PROVIDERS registry', () => {
  test('exposes bun, pnpm and yarn with install commands and lockfiles', () => {
    expect(Object.keys(PROVIDERS).toSorted()).toEqual(['bun', 'pnpm', 'yarn'])
    expect(PROVIDERS.bun.installCommand).toEqual(['bun', 'install'])
    expect(PROVIDERS.bun.lockfileName).toBe('bun.lock')
    // CI runners default pnpm to --frozen-lockfile, which rejects the catalog
    // edits this action writes before installing.
    expect(PROVIDERS.pnpm.installCommand).toEqual([
      'pnpm',
      'install',
      '--no-frozen-lockfile'
    ])
    expect(PROVIDERS.pnpm.lockfileName).toBe('pnpm-lock.yaml')
    // CI runners make Yarn Berry default to immutable installs, which
    // rejects the catalog edits this action writes before installing.
    expect(PROVIDERS.yarn.installCommand).toEqual([
      'yarn',
      'install',
      '--no-immutable'
    ])
    expect(PROVIDERS.yarn.lockfileName).toBe('yarn.lock')
    expect(PROVIDERS.bun.installArtifacts).toEqual(['bun.lock', 'bun.lockb'])
    expect(PROVIDERS.pnpm.installArtifacts).toEqual([
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml'
    ])
    expect(PROVIDERS.yarn.installArtifacts).toEqual(['yarn.lock', '.yarnrc.yml'])
  })

  test('exposes an audit capability for every provider', () => {
    expect(PROVIDERS.bun.audit.command).toEqual(['bun', 'audit', '--json'])
    expect(PROVIDERS.pnpm.audit.command).toEqual(['pnpm', 'audit', '--json'])
    expect(PROVIDERS.yarn.audit.command).toEqual([
      'yarn',
      'npm',
      'audit',
      '--json',
      '--all',
      '--recursive'
    ])
    expect(PROVIDERS.bun.audit.overrideFile).toBe('package.json')
    expect(PROVIDERS.pnpm.audit.overrideFile).toBe('pnpm-workspace.yaml')
    expect(PROVIDERS.yarn.audit.overrideFile).toBe('package.json')
    expect(PROVIDERS.yarn.audit.overrideField).toBe('resolutions')
  })

  test('getProvider resolves by id', () => {
    expect(getProvider('pnpm').id).toBe('pnpm')
    expect(getProvider('yarn').id).toBe('yarn')
    expect(getProvider('bun').id).toBe('bun')
  })
})

// ---------------------------------------------------------------------------
// bun
// ---------------------------------------------------------------------------

const bun = getProvider('bun')

describe('bun provider', () => {
  test('parses top-level catalog and named catalogs', () => {
    const content = JSON.stringify({
      name: 'root',
      catalog: { react: '^19.0.0' },
      catalogs: { testing: { jest: '30.0.0' } }
    })

    const definitions = bun.parseDefinitions({ content })

    expect(definitions).toEqual([
      { catalogName: 'default', entries: { react: '^19.0.0' } },
      { catalogName: 'testing', entries: { jest: '30.0.0' } }
    ])
  })

  test('parses catalogs nested under workspaces', () => {
    const content = JSON.stringify({
      workspaces: {
        packages: ['packages/*'],
        catalog: { react: '^19.0.0' },
        catalogs: { ui: { tailwind: '4.0.0' } }
      }
    })

    const definitions = bun.parseDefinitions({ content })

    expect(definitions).toEqual([
      { catalogName: 'default', entries: { react: '^19.0.0' } },
      { catalogName: 'ui', entries: { tailwind: '4.0.0' } }
    ])
  })

  test('prefers singular catalog over catalogs.default', () => {
    const content = JSON.stringify({
      catalog: { react: '^19.0.0' },
      catalogs: { default: { react: '^18.0.0' } }
    })

    const definitions = bun.parseDefinitions({ content })

    expect(definitions).toEqual([
      { catalogName: 'default', entries: { react: '^19.0.0' } }
    ])
  })

  test('returns empty for non-catalog package.json or invalid JSON', () => {
    expect(bun.parseDefinitions({ content: JSON.stringify({ name: 'root' }) })).toEqual([])
    expect(bun.parseDefinitions({ content: 'not json' })).toEqual([])
  })

  test('applyUpdates rewrites package.json with updated values', () => {
    const content = JSON.stringify({
      name: 'root',
      catalog: { react: '^18.0.0', zod: '3.0.0' },
      catalogs: { testing: { jest: '29.0.0' } }
    })

    const updated = bun.applyUpdates({
      content,
      catalogName: 'default',
      updates: [makeCandidate({ name: 'react', latestVersion: '19.1.0', rangePrefix: '^' })]
    })

    const pkg = JSON.parse(updated)
    expect(pkg.catalog).toEqual({ react: '^19.1.0', zod: '3.0.0' })
    expect(pkg.name).toBe('root')
    expect(updated.endsWith('\n')).toBe(true)
  })

  test('applyUpdates targets named catalogs', () => {
    const content = JSON.stringify({
      catalog: { react: '^18.0.0' },
      catalogs: { testing: { jest: '29.0.0' } }
    })

    const updated = bun.applyUpdates({
      content,
      catalogName: 'testing',
      updates: [makeCandidate({ name: 'jest', latestVersion: '30.0.0' })]
    })

    const pkg = JSON.parse(updated)
    expect(pkg.catalog).toEqual({ react: '^18.0.0' })
    expect(pkg.catalogs.testing).toEqual({ jest: '30.0.0' })
  })

  test('applyUpdates throws for unknown catalog', () => {
    expect(() =>
      bun.applyUpdates({
        content: JSON.stringify({ catalog: { react: '^18.0.0' } }),
        catalogName: 'nonexistent',
        updates: []
      })
    ).toThrow('No catalog "nonexistent" found')
  })
})

// ---------------------------------------------------------------------------
// pnpm + yarn (shared YAML implementation)
// ---------------------------------------------------------------------------

const YAML_PROVIDERS: Array<[ProviderId, string]> = [
  ['pnpm', 'pnpm-workspace.yaml'],
  ['yarn', '.yarnrc.yml']
]

describe.each(YAML_PROVIDERS)('%s provider (YAML)', (id, fileName) => {
  const provider = getProvider(id)

  test('parses default and named catalogs', () => {
    const content = [
      'packages:',
      '  - packages/*',
      '',
      'catalog:',
      '  react: ^19.0.0',
      '',
      'catalogs:',
      '  react18:',
      '    react: ^18.3.1',
      ''
    ].join('\n')

    expect(provider.parseDefinitions({ content })).toEqual([
      { catalogName: 'default', entries: { react: '^19.0.0' } },
      { catalogName: 'react18', entries: { react: '^18.3.1' } }
    ])
  })

  test('returns empty for files without catalogs or invalid YAML', () => {
    expect(provider.parseDefinitions({ content: 'packages:\n  - packages/*\n' })).toEqual([])
    expect(provider.parseDefinitions({ content: 'catalog: [unclosed\n  bad: :' })).toEqual([])
    expect(provider.parseDefinitions({ content: '' })).toEqual([])
  })

  test('ignores non-string catalog entries', () => {
    const content = 'catalog:\n  react: ^19.0.0\n  bad: 3\n'
    expect(provider.parseDefinitions({ content })).toEqual([])
  })

  test('applyUpdates preserves comments and surrounding structure', () => {
    const content = [
      '# Workspace config',
      'packages:',
      '  - packages/*',
      '',
      'catalog:',
      '  # pinned by platform team',
      '  react: ^18.0.0',
      '  zod: 3.0.0',
      ''
    ].join('\n')

    const updated = provider.applyUpdates({
      content,
      catalogName: 'default',
      updates: [makeCandidate({ name: 'react', latestVersion: '19.1.0', rangePrefix: '^' })]
    })

    expect(updated).toContain('# Workspace config')
    expect(updated).toContain('# pinned by platform team')
    expect(updated).toContain('react: ^19.1.0')
    expect(updated).toContain('zod: 3.0.0')
    expect(updated).toContain('  - packages/*')

    // The result must round-trip to the same catalog definitions
    expect(provider.parseDefinitions({ content: updated })).toEqual([
      { catalogName: 'default', entries: { react: '^19.1.0', zod: '3.0.0' } }
    ])
  })

  test('applyUpdates targets named catalogs', () => {
    const content = 'catalog:\n  react: ^18.0.0\n\ncatalogs:\n  react18:\n    react: ^18.3.1\n'

    const updated = provider.applyUpdates({
      content,
      catalogName: 'react18',
      updates: [makeCandidate({ name: 'react', latestVersion: '18.3.2', rangePrefix: '^' })]
    })

    expect(updated).toContain('react: ^18.0.0')
    expect(updated).toContain('react: ^18.3.2')
    expect(provider.parseDefinitions({ content: updated })).toEqual([
      { catalogName: 'default', entries: { react: '^18.0.0' } },
      { catalogName: 'react18', entries: { react: '^18.3.2' } }
    ])
  })

  test('applyUpdates preserves quoting styles and npm: aliases', () => {
    const content = `catalog:\n  react: "^18.0.0"\n  vite: "npm:rolldown-vite@^7.3.1"\n`

    const updated = provider.applyUpdates({
      content,
      catalogName: 'default',
      updates: [
        makeCandidate({ name: 'react', latestVersion: '19.1.0', rangePrefix: '^' }),
        makeCandidate({ name: 'vite', npmName: 'rolldown-vite', isAlias: true, latestVersion: '7.4.0', rangePrefix: '^' })
      ]
    })

    expect(provider.parseDefinitions({ content: updated })).toEqual([
      {
        catalogName: 'default',
        entries: { react: '^19.1.0', vite: 'npm:rolldown-vite@^7.4.0' }
      }
    ])
  })

  test('applyUpdates handles tilde-prefixed versions', () => {
    const content = 'catalog:\n  lodash: ~4.17.0\n'

    const updated = provider.applyUpdates({
      content,
      catalogName: 'default',
      updates: [makeCandidate({ name: 'lodash', latestVersion: '4.18.0', rangePrefix: '~' })]
    })

    expect(provider.parseDefinitions({ content: updated })).toEqual([
      { catalogName: 'default', entries: { lodash: '~4.18.0' } }
    ])
  })

  test(`applyUpdates throws on structurally invalid ${fileName}`, () => {
    // A top-level scalar cannot host a catalog mapping
    expect(() =>
      provider.applyUpdates({
        content: 'just a string\n',
        catalogName: 'default',
        updates: [makeCandidate({ name: 'react' })]
      })
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// audit capabilities
// ---------------------------------------------------------------------------

// Real output captured from `pnpm audit --json` (pnpm 11, npm 6 style,
// trimmed to the fields the parser consumes — cwe arrives as a bare string).
const PNPM_AUDIT_OUTPUT = JSON.stringify({
  advisories: {
    1_097_678: {
      id: 1_097_678,
      module_name: 'minimist',
      severity: 'critical',
      vulnerable_versions: '>=1.0.0 <1.2.6',
      title: 'Prototype Pollution in minimist',
      url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h',
      cvss: { score: 9.8, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
      cwe: 'CWE-1321'
    }
  },
  metadata: { vulnerabilities: {} }
})

// pnpm <= 10 emits cwe as the npm 6 array; both forms must normalize to
// the array the advisory type expects.
const PNPM_AUDIT_OUTPUT_ARRAY_CWE = JSON.stringify({
  advisories: {
    1_097_678: {
      id: '1097678',
      module_name: 'minimist',
      severity: 'critical',
      vulnerable_versions: '>=1.0.0 <1.2.6',
      title: 'Prototype Pollution in minimist',
      url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h',
      cwe: ['CWE-1321']
    }
  },
  metadata: { vulnerabilities: {} }
})

// Real output captured from `yarn npm audit --json` (NDJSON, one line per
// advisory, capitalized severities, no CVSS/CWE data).
const YARN_AUDIT_OUTPUT = [
  '{"value":"minimist","children":{"ID":1097678,"Issue":"Prototype Pollution in minimist","URL":"https://github.com/advisories/GHSA-xvch-5gv4-984h","Severity":"critical","Vulnerable Versions":">=1.0.0 <1.2.6","Tree Versions":["1.2.5"],"Dependents":["audit-fixture@workspace:."]}}',
  '{"value":"lodash","children":{"ID":1106913,"Issue":"Command Injection in lodash","URL":"https://github.com/advisories/GHSA-35jh-r3h4-6jhm","Severity":"High","Vulnerable Versions":"<4.17.21","Tree Versions":["4.17.20"]}}'
].join('\n')

const minimistOverride = {
  packageName: 'minimist',
  vulnerableRange: '>=1.0.0 <1.2.6',
  fixedVersion: '1.2.6',
  advisories: [makeAdvisory()]
}

describe('audit capabilities', () => {
  test('bun parses its grouped advisory shape', () => {
    const output = JSON.stringify({
      minimist: [
        {
          id: 1_097_678,
          url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h',
          title: 'Prototype Pollution in minimist',
          severity: 'critical',
          vulnerable_versions: '>=1.0.0 <1.2.6',
          cwe: ['CWE-1321'],
          cvss: { score: 9.8, vectorString: 'CVSS:3.1/AV:N' }
        }
      ]
    })

    const result = PROVIDERS.bun.audit.parseOutput({ output })
    expect(result).toEqual({
      minimist: [
        expect.objectContaining({ id: 1_097_678, severity: 'critical' })
      ]
    })
    expect(PROVIDERS.bun.audit.parseOutput({ output: 'not json' })).toBeNull()
  })

  test('pnpm parses npm-6 style advisories grouped by module_name', () => {
    const result = PROVIDERS.pnpm.audit.parseOutput({ output: PNPM_AUDIT_OUTPUT })

    expect(result).toEqual({
      minimist: [
        {
          id: 1_097_678,
          url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h',
          title: 'Prototype Pollution in minimist',
          severity: 'critical',
          vulnerable_versions: '>=1.0.0 <1.2.6',
          cwe: ['CWE-1321'],
          cvss: { score: 9.8, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }
        }
      ]
    })
  })

  test('pnpm accepts array-form cwe and string advisory ids', () => {
    const result = PROVIDERS.pnpm.audit.parseOutput({
      output: PNPM_AUDIT_OUTPUT_ARRAY_CWE
    })

    expect(result?.minimist?.[0]?.cwe).toEqual(['CWE-1321'])
    expect(result?.minimist?.[0]?.id).toBe(1_097_678)
  })

  test('pnpm returns null for unexpected formats', () => {
    expect(PROVIDERS.pnpm.audit.parseOutput({ output: '{"foo": 1}' })).toBeNull()
    expect(PROVIDERS.pnpm.audit.parseOutput({ output: 'fatal: error' })).toBeNull()
  })

  test('yarn parses NDJSON advisories with normalized severities', () => {
    const result = PROVIDERS.yarn.audit.parseOutput({ output: YARN_AUDIT_OUTPUT })

    expect(result?.minimist).toEqual([
      {
        id: 1_097_678,
        url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h',
        title: 'Prototype Pollution in minimist',
        severity: 'critical',
        vulnerable_versions: '>=1.0.0 <1.2.6'
      }
    ])
    expect(result?.lodash?.[0]?.severity).toBe('high')
  })

  test('yarn treats empty output as clean and garbage as unparseable', () => {
    expect(PROVIDERS.yarn.audit.parseOutput({ output: '' })).toEqual({})
    expect(
      PROVIDERS.yarn.audit.parseOutput({ output: 'not json at all' })
    ).toBeNull()
  })

  test('bun reads and writes package.json overrides', () => {
    const audit = PROVIDERS.bun.audit
    const content = JSON.stringify({
      name: 'root',
      overrides: { 'minimist@<1.2.6': '1.2.5' }
    })

    expect(audit.readOverrides({ content })).toEqual({
      'minimist@<1.2.6': '1.2.5'
    })

    const updated = audit.writeOverrides({
      content,
      map: { 'minimist@<1.2.6': '1.2.6' }
    })
    expect(JSON.parse(updated).overrides).toEqual({ 'minimist@<1.2.6': '1.2.6' })
    expect(JSON.parse(updated).name).toBe('root')

    const cleared = audit.writeOverrides({ content, map: {} })
    expect(JSON.parse(cleared).overrides).toBeUndefined()
  })

  test('pnpm reads and writes pnpm-workspace.yaml overrides, preserving comments', () => {
    const audit = PROVIDERS.pnpm.audit
    const content = '# workspace\npackages:\n  - packages/*\noverrides:\n  # security pin\n  minimist@<1.2.6: 1.2.5\n'

    expect(audit.readOverrides({ content })).toEqual({
      'minimist@<1.2.6': '1.2.5'
    })

    const updated = audit.writeOverrides({
      content,
      map: { 'minimist@<1.2.6': '1.2.6', lodash: '4.17.21' }
    })
    expect(updated).toContain('# workspace')
    expect(updated).toContain('# security pin')
    expect(audit.readOverrides({ content: updated })).toEqual({
      'minimist@<1.2.6': '1.2.6',
      lodash: '4.17.21'
    })

    const cleared = audit.writeOverrides({ content, map: {} })
    expect(audit.readOverrides({ content: cleared })).toBeUndefined()
    expect(cleared).not.toContain('minimist')
    expect(cleared).toContain('packages:')
  })

  test('yarn reads and writes package.json resolutions', () => {
    const audit = PROVIDERS.yarn.audit
    const content = JSON.stringify({
      name: 'root',
      resolutions: { minimist: '1.2.5', 'user-range': '^1.0.0' }
    })

    expect(audit.readOverrides({ content })).toEqual({
      minimist: '1.2.5',
      'user-range': '^1.0.0'
    })

    const updated = audit.writeOverrides({
      content,
      map: { minimist: '1.2.6', 'user-range': '^1.0.0' }
    })
    expect(JSON.parse(updated).resolutions).toEqual({
      minimist: '1.2.6',
      'user-range': '^1.0.0'
    })
  })

  test('yarn keys overrides by package name and owns exact-semver values', () => {
    const audit = PROVIDERS.yarn.audit
    expect(audit.overrideKey(minimistOverride)).toBe('minimist')
    expect(audit.isManagedOverride('minimist', '1.2.6')).toBe(true)
    expect(audit.isManagedOverride('some-package', '^2.0.0')).toBe(false)
  })

  test('bun and pnpm keys overrides by name@range', () => {
    const rangeKeyedProviders: Array<ProviderId> = ['bun', 'pnpm']
    for (const id of rangeKeyedProviders) {
      const audit = PROVIDERS[id].audit
      expect(audit.overrideKey(minimistOverride)).toBe(
        'minimist@>=1.0.0 <1.2.6'
      )
      expect(audit.isManagedOverride('minimist@>=1.0.0 <1.2.6', '1.2.6')).toBe(true)
      expect(audit.isManagedOverride('some-package', '1.2.6')).toBe(false)
    }
  })
})
