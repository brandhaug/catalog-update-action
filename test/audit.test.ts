import { describe, expect, test } from 'bun:test'
import { parseFixedVersion, computeOverrides, computeOverrideMap, buildOverridePrBody, isOverrideBranchOutdated, buildOverrideBranchUpdate } from '../src/audit'
import { overrideKey, isToolOverrideKey } from '../src/utils'
import { PROVIDERS } from '../src/providers'
import { type JsonObject } from '../src/schemas'
import { type AuditAdvisory, type AuditResult, type OverrideEntry } from '../src/types'

const bunAudit = PROVIDERS.bun.audit
const yarnAudit = PROVIDERS.yarn.audit

const bunFiles = (pkg: JsonObject): Map<string, string | null> =>
  new Map([['package.json', JSON.stringify(pkg)]])
const pnpmFiles = (yaml: string): Map<string, string | null> =>
  new Map([['pnpm-workspace.yaml', yaml]])

function makeAdvisory(overrides: Partial<AuditAdvisory> = {}): AuditAdvisory {
  return {
    id: 1234,
    url: 'https://github.com/advisories/GHSA-1234',
    title: 'Test Advisory',
    severity: 'high',
    vulnerable_versions: '<1.0.0',
    cwe: ['CWE-79'],
    cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N' },
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// parseFixedVersion
// ---------------------------------------------------------------------------

describe('parseFixedVersion', () => {
  test('extracts version from simple < bound', () => {
    expect(parseFixedVersion({ vulnerableVersions: '<1.30.0' })).toBe('1.30.0')
  })

  test('extracts version from range with upper bound', () => {
    expect(parseFixedVersion({ vulnerableVersions: '>=0.3.41 <0.4.6' })).toBe('0.4.6')
  })

  test('takes highest from multiple OR ranges', () => {
    expect(parseFixedVersion({ vulnerableVersions: '>=0.3.41 <0.4.6 || >=0.5.0 <0.5.3' })).toBe('0.5.3')
  })

  test('returns null when no upper bound', () => {
    expect(parseFixedVersion({ vulnerableVersions: '>=1.0.0' })).toBeNull()
  })

  test('excludes <= bounds (bound version itself is vulnerable)', () => {
    expect(parseFixedVersion({ vulnerableVersions: '<=1.0.0' })).toBeNull()
  })

  test('returns null for empty string', () => {
    expect(parseFixedVersion({ vulnerableVersions: '' })).toBeNull()
  })

  test('handles prerelease in bound', () => {
    expect(parseFixedVersion({ vulnerableVersions: '<1.0.0-beta.2' })).toBe('1.0.0-beta.2')
  })

  test('handles mixed <= and < in same range', () => {
    // Only strict < bounds should be considered
    expect(parseFixedVersion({ vulnerableVersions: '<=1.0.0 || <2.0.0' })).toBe('2.0.0')
  })
})

// ---------------------------------------------------------------------------
// computeOverrides
// ---------------------------------------------------------------------------

describe('computeOverrides', () => {
  test('basic case — returns override with vulnerableRange', () => {
    const auditResult: AuditResult = {
      'lodash': [makeAdvisory({ vulnerable_versions: '<4.17.21', severity: 'high' })]
    }

    const result = computeOverrides({
      audit: bunAudit,
      auditResult,
      catalogNames: new Set(),
      minimumSeverity: 'moderate',
      existingOverrides: {}
    })

    expect(result).toHaveLength(1)
    expect(result[0]!.packageName).toBe('lodash')
    expect(result[0]!.vulnerableRange).toBe('<4.17.21')
    expect(result[0]!.fixedVersion).toBe('4.17.21')
    expect(overrideKey(result[0]!)).toBe('lodash@<4.17.21')
  })

  test('skips packages in catalogNames (direct deps)', () => {
    const auditResult: AuditResult = {
      'react': [makeAdvisory({ vulnerable_versions: '<19.0.0', severity: 'high' })]
    }

    const result = computeOverrides({
      audit: bunAudit,
      auditResult,
      catalogNames: new Set(['react']),
      minimumSeverity: 'moderate',
      existingOverrides: {}
    })

    expect(result).toHaveLength(0)
  })

  test('filters advisories below minimum severity', () => {
    const auditResult: AuditResult = {
      'lodash': [makeAdvisory({ vulnerable_versions: '<4.17.21', severity: 'low' })]
    }

    const result = computeOverrides({
      audit: bunAudit,
      auditResult,
      catalogNames: new Set(),
      minimumSeverity: 'high',
      existingOverrides: {}
    })

    expect(result).toHaveLength(0)
  })

  test('same vulnerable_versions groups advisories together', () => {
    const auditResult: AuditResult = {
      'lodash': [
        makeAdvisory({ id: 1, vulnerable_versions: '<4.17.21', severity: 'high' }),
        makeAdvisory({ id: 2, vulnerable_versions: '<4.17.21', severity: 'critical' })
      ]
    }

    const result = computeOverrides({
      audit: bunAudit,
      auditResult,
      catalogNames: new Set(),
      minimumSeverity: 'moderate',
      existingOverrides: {}
    })

    expect(result).toHaveLength(1)
    expect(result[0]!.vulnerableRange).toBe('<4.17.21')
    expect(result[0]!.fixedVersion).toBe('4.17.21')
    expect(result[0]!.advisories).toHaveLength(2)
  })

  test('different vulnerable_versions produce separate entries', () => {
    const auditResult: AuditResult = {
      'ws': [
        makeAdvisory({ id: 1, vulnerable_versions: '>=7.0.0 <7.5.10', severity: 'high' }),
        makeAdvisory({ id: 2, vulnerable_versions: '>=8.0.0 <8.17.1', severity: 'high' })
      ]
    }

    const result = computeOverrides({
      audit: bunAudit,
      auditResult,
      catalogNames: new Set(),
      minimumSeverity: 'moderate',
      existingOverrides: {}
    })

    expect(result).toHaveLength(2)
    const sorted = [...result].toSorted((a, b) => a.vulnerableRange.localeCompare(b.vulnerableRange))
    expect(sorted[0]!.vulnerableRange).toBe('>=7.0.0 <7.5.10')
    expect(sorted[0]!.fixedVersion).toBe('7.5.10')
    expect(overrideKey(sorted[0]!)).toBe('ws@>=7.0.0 <7.5.10')
    expect(sorted[1]!.vulnerableRange).toBe('>=8.0.0 <8.17.1')
    expect(sorted[1]!.fixedVersion).toBe('8.17.1')
    expect(overrideKey(sorted[1]!)).toBe('ws@>=8.0.0 <8.17.1')
  })

  test('includes stale overrides (existing but still reported by audit)', () => {
    const auditResult: AuditResult = {
      'lodash': [makeAdvisory({ vulnerable_versions: '<4.17.21', severity: 'high' })]
    }

    const result = computeOverrides({
      audit: bunAudit,
      auditResult,
      catalogNames: new Set(),
      minimumSeverity: 'moderate',
      existingOverrides: { 'lodash@<4.17.21': '4.17.21' }
    })

    expect(result).toHaveLength(1)
    expect(result[0]!.existingOverrideStale).toBe(true)
  })

  test('skips when no upper bound in vulnerable_versions', () => {
    const auditResult: AuditResult = {
      'lodash': [makeAdvisory({ vulnerable_versions: '>=1.0.0', severity: 'high' })]
    }

    const result = computeOverrides({
      audit: bunAudit,
      auditResult,
      catalogNames: new Set(),
      minimumSeverity: 'moderate',
      existingOverrides: {}
    })

    expect(result).toHaveLength(0)
  })

  test('returns empty for no qualifying advisories', () => {
    const result = computeOverrides({
      audit: bunAudit,
      auditResult: {},
      catalogNames: new Set(),
      minimumSeverity: 'moderate',
      existingOverrides: {}
    })

    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// buildOverridePrBody
// ---------------------------------------------------------------------------

describe('buildOverridePrBody', () => {
  const overrides: Array<OverrideEntry> = [
    {
      packageName: 'lodash',
      vulnerableRange: '<4.17.21',
      fixedVersion: '4.17.21',
      advisories: [makeAdvisory({ id: 100, severity: 'high', title: 'Prototype Pollution' })]
    }
  ]

  test('contains summary table with vulnerable range column', () => {
    const body = buildOverridePrBody({ overrides })

    expect(body).toContain('| Package | Vulnerable Range | Fixed Version | Severity | Advisory |')
    expect(body).toContain('| `lodash` | `<4.17.21` | 4.17.21 |')
  })

  test('contains advisory details in collapsible sections', () => {
    const body = buildOverridePrBody({ overrides })

    expect(body).toContain('<details>')
    expect(body).toContain('Prototype Pollution')
    expect(body).toContain('</details>')
  })

  test('contains footer with auto-generated note', () => {
    const body = buildOverridePrBody({ overrides })

    expect(body).toContain('auto-generated by')
  })

  test('omits CVSS and CWE lines when the advisory lacks them', () => {
    const body = buildOverridePrBody({
      overrides: [
        {
          packageName: 'minimist',
          vulnerableRange: '<1.2.6',
          fixedVersion: '1.2.6',
          // Yarn advisories carry no CVSS/CWE data
          advisories: [makeAdvisory({ cvss: undefined, cwe: undefined })]
        }
      ]
    })

    expect(body).toContain('**Severity**: high')
    expect(body).not.toContain('CVSS')
    expect(body).not.toContain('**CWE**')
  })
})

// ---------------------------------------------------------------------------
// buildOverrideBranchUpdate
// ---------------------------------------------------------------------------

describe('buildOverrideBranchUpdate', () => {
  test('builds correct branch name', () => {
    const overrides: Array<OverrideEntry> = [{
      packageName: 'lodash',
      vulnerableRange: '<4.17.21',
      fixedVersion: '4.17.21',
      advisories: [makeAdvisory()]
    }]

    const result = buildOverrideBranchUpdate({
      overrides,
      branchPrefix: 'catalog-update',
      workDir: '/tmp/work',
      providerId: 'bun'
    })

    expect(result.branch).toBe('catalog-update-override/vulnerability-fixes')
  })

  test('singular title for one dependency', () => {
    const overrides: Array<OverrideEntry> = [{
      packageName: 'lodash',
      vulnerableRange: '<4.17.21',
      fixedVersion: '4.17.21',
      advisories: [makeAdvisory()]
    }]

    const result = buildOverrideBranchUpdate({
      overrides,
      branchPrefix: 'catalog-update',
      workDir: '/tmp/work',
      providerId: 'bun'
    })

    expect(result.title).toBe('fix(security): override 1 vulnerable transitive dependency')
  })

  test('plural title for multiple dependencies', () => {
    const overrides: Array<OverrideEntry> = [
      { packageName: 'lodash', vulnerableRange: '<4.17.21', fixedVersion: '4.17.21', advisories: [makeAdvisory()] },
      { packageName: 'minimist', vulnerableRange: '<1.2.6', fixedVersion: '1.2.6', advisories: [makeAdvisory()] }
    ]

    const result = buildOverrideBranchUpdate({
      overrides,
      branchPrefix: 'catalog-update',
      workDir: '/tmp/work',
      providerId: 'bun'
    })

    expect(result.title).toBe('fix(security): override 2 vulnerable transitive dependencies')
  })

  test('appends titleSuffix for working directory', () => {
    const overrides: Array<OverrideEntry> = [{
      packageName: 'lodash',
      vulnerableRange: '<4.17.21',
      fixedVersion: '4.17.21',
      advisories: [makeAdvisory()]
    }]

    const result = buildOverrideBranchUpdate({
      overrides,
      branchPrefix: 'catalog-update/apps/backend',
      titleSuffix: ' in /apps/backend',
      workDir: '/tmp/work',
      providerId: 'bun'
    })

    expect(result.branch).toBe('catalog-update/apps/backend-override/vulnerability-fixes')
    expect(result.title).toBe('fix(security): override 1 vulnerable transitive dependency in /apps/backend')
  })

  test('targets package.json with the provider lockfile for re-resolution', () => {
    const overrides: Array<OverrideEntry> = [{
      packageName: 'lodash',
      vulnerableRange: '<4.17.21',
      fixedVersion: '4.17.21',
      advisories: [makeAdvisory()]
    }]

    const result = buildOverrideBranchUpdate({
      overrides,
      branchPrefix: 'catalog-update',
      workDir: '/tmp/work',
      providerId: 'bun'
    })

    expect(result.affectedFiles).toEqual(['package.json'])
    expect(result.deleteLockfiles).toEqual(['bun.lock'])
    expect(result.installCommand).toEqual(['bun', 'install'])
  })

  test('computeOverrideMap removes stale tool overrides and preserves user overrides', () => {
    const overrides: Array<OverrideEntry> = [{
      packageName: 'lodash',
      vulnerableRange: '<4.17.21',
      fixedVersion: '4.17.21',
      advisories: [makeAdvisory()]
    }]

    const map = computeOverrideMap({
      existing: {
        'minimist@<1.2.6': '1.2.6', // stale tool override — should be removed
        'some-package': '1.0.0' // user override — should be preserved
      },
      overrides,
      audit: bunAudit
    })

    expect(map).toEqual({
      'lodash@<4.17.21': '4.17.21',
      'some-package': '1.0.0'
    })
  })

  test('computeOverrideMap removes overrides when nothing is needed', () => {
    const map = computeOverrideMap({
      existing: { 'minimist@<1.2.6': '1.2.6' },
      overrides: [],
      audit: bunAudit
    })

    expect(map).toEqual({})
  })

  test('computeOverrideMap collapses same-key entries to the highest fixed version', () => {
    // Yarn keys overrides by package name alone, so two advisory ranges for
    // the same package collapse into one entry.
    const map = computeOverrideMap({
      existing: {},
      overrides: [
        { packageName: 'lodash', vulnerableRange: '<4.17.21', fixedVersion: '4.17.21', advisories: [makeAdvisory()] },
        { packageName: 'lodash', vulnerableRange: '<4.17.20', fixedVersion: '4.17.22', advisories: [makeAdvisory()] }
      ],
      audit: yarnAudit
    })

    expect(map).toEqual({ lodash: '4.17.22' })
  })
})

// ---------------------------------------------------------------------------
// isOverrideBranchOutdated
// ---------------------------------------------------------------------------

describe('isOverrideBranchOutdated', () => {
  const expectedOverrides: Array<OverrideEntry> = [
    {
      packageName: 'lodash',
      vulnerableRange: '<4.17.21',
      fixedVersion: '4.17.21',
      advisories: [makeAdvisory()]
    }
  ]

  test('returns true when overrides field missing', () => {
    const result = isOverrideBranchOutdated({
      branchFiles: bunFiles({}),
      audit: bunAudit,
      expectedOverrides
    })
    expect(result).toBe(true)
  })

  test('returns false when overrides match (scoped key)', () => {
    const result = isOverrideBranchOutdated({
      branchFiles: bunFiles({ overrides: { 'lodash@<4.17.21': '4.17.21' } }),
      audit: bunAudit,
      expectedOverrides
    })
    expect(result).toBe(false)
  })

  test('returns true when override values are stale', () => {
    const result = isOverrideBranchOutdated({
      branchFiles: bunFiles({ overrides: { 'lodash@<4.17.21': '4.17.19' } }),
      audit: bunAudit,
      expectedOverrides
    })
    expect(result).toBe(true)
  })

  test('returns true when branch has extra tool-generated overrides', () => {
    const result = isOverrideBranchOutdated({
      branchFiles: bunFiles({
        overrides: {
          'lodash@<4.17.21': '4.17.21',
          'minimist@<1.2.6': '1.2.6'
        }
      }),
      audit: bunAudit,
      expectedOverrides
    })
    expect(result).toBe(true)
  })

  test('returns false when branch has extra user-added overrides', () => {
    const result = isOverrideBranchOutdated({
      branchFiles: bunFiles({
        overrides: {
          'lodash@<4.17.21': '4.17.21',
          'some-package': '2.0.0'
        }
      }),
      audit: bunAudit,
      expectedOverrides
    })
    expect(result).toBe(false)
  })

  test('returns false when no overrides expected and none present', () => {
    const result = isOverrideBranchOutdated({
      branchFiles: bunFiles({}),
      audit: bunAudit,
      expectedOverrides: []
    })
    expect(result).toBe(false)
  })

  test('reads pnpm overrides from pnpm-workspace.yaml', () => {
    const result = isOverrideBranchOutdated({
      branchFiles: pnpmFiles('packages:\n  - packages/*\noverrides:\n  lodash@<4.17.21: 4.17.21\n'),
      audit: PROVIDERS.pnpm.audit,
      expectedOverrides
    })
    expect(result).toBe(false)
  })

  test('reads yarn overrides from package.json resolutions', () => {
    const result = isOverrideBranchOutdated({
      branchFiles: bunFiles({ resolutions: { lodash: '4.17.21' } }),
      audit: yarnAudit,
      expectedOverrides
    })
    expect(result).toBe(false)
  })

  test('yarn exact-pinned stale entries are managed and reported', () => {
    const result = isOverrideBranchOutdated({
      branchFiles: bunFiles({ resolutions: { lodash: '4.17.19' } }),
      audit: yarnAudit,
      expectedOverrides
    })
    expect(result).toBe(true)
  })

  test('yarn range-valued user resolutions are never managed', () => {
    const result = isOverrideBranchOutdated({
      branchFiles: bunFiles({ resolutions: { 'some-package': '^2.0.0' } }),
      audit: yarnAudit,
      expectedOverrides: []
    })
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isToolOverrideKey
// ---------------------------------------------------------------------------

describe('isToolOverrideKey', () => {
  test('returns true for tool-generated key with < bound', () => {
    expect(isToolOverrideKey('lodash@<4.17.21')).toBe(true)
  })

  test('returns true for tool-generated key with >= bound', () => {
    expect(isToolOverrideKey('ws@>=7.0.0 <7.5.10')).toBe(true)
  })

  test('returns false for plain package name', () => {
    expect(isToolOverrideKey('lodash')).toBe(false)
  })

  test('returns false for scoped package without range', () => {
    expect(isToolOverrideKey('@types/node')).toBe(false)
  })

  test('returns true for scoped package with vulnerable range', () => {
    expect(isToolOverrideKey('@scope/pkg@<2.0.0')).toBe(true)
  })
})
