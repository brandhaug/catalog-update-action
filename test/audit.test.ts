import { describe, expect, test } from 'bun:test'
import { parseFixedVersion, computeOverrides, buildOverridePrBody, isOverrideBranchOutdated, buildOverrideBranchUpdate, overrideKey } from '../src/audit'
import type { AuditAdvisory, AuditResult, OverrideEntry, Severity } from '../src/types'

function makeAdvisory(overrides: Partial<AuditAdvisory> = {}): AuditAdvisory {
  return {
    id: 1234,
    url: 'https://github.com/advisories/GHSA-1234',
    title: 'Test Advisory',
    severity: 'high' as Severity,
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
      auditResult,
      catalogNames: new Set(),
      minimumSeverity: 'moderate',
      existingOverrides: {}
    })

    expect(result).toHaveLength(2)
    const sorted = [...result].sort((a, b) => a.vulnerableRange.localeCompare(b.vulnerableRange))
    expect(sorted[0]!.vulnerableRange).toBe('>=7.0.0 <7.5.10')
    expect(sorted[0]!.fixedVersion).toBe('7.5.10')
    expect(overrideKey(sorted[0]!)).toBe('ws@>=7.0.0 <7.5.10')
    expect(sorted[1]!.vulnerableRange).toBe('>=8.0.0 <8.17.1')
    expect(sorted[1]!.fixedVersion).toBe('8.17.1')
    expect(overrideKey(sorted[1]!)).toBe('ws@>=8.0.0 <8.17.1')
  })

  test('skips if existing override (scoped key) already at or above fixed version', () => {
    const auditResult: AuditResult = {
      'lodash': [makeAdvisory({ vulnerable_versions: '<4.17.21', severity: 'high' })]
    }

    const result = computeOverrides({
      auditResult,
      catalogNames: new Set(),
      minimumSeverity: 'moderate',
      existingOverrides: { 'lodash@<4.17.21': '4.17.21' }
    })

    expect(result).toHaveLength(0)
  })

  test('skips when no upper bound in vulnerable_versions', () => {
    const auditResult: AuditResult = {
      'lodash': [makeAdvisory({ vulnerable_versions: '>=1.0.0', severity: 'high' })]
    }

    const result = computeOverrides({
      auditResult,
      catalogNames: new Set(),
      minimumSeverity: 'moderate',
      existingOverrides: {}
    })

    expect(result).toHaveLength(0)
  })

  test('returns empty for no qualifying advisories', () => {
    const result = computeOverrides({
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
  const overrides: OverrideEntry[] = [
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
    expect(body).toContain('Bun overrides documentation')
  })
})

// ---------------------------------------------------------------------------
// buildOverrideBranchUpdate
// ---------------------------------------------------------------------------

describe('buildOverrideBranchUpdate', () => {
  test('builds correct branch name', () => {
    const overrides: OverrideEntry[] = [{
      packageName: 'lodash',
      vulnerableRange: '<4.17.21',
      fixedVersion: '4.17.21',
      advisories: [makeAdvisory()]
    }]

    const result = buildOverrideBranchUpdate({
      overrides,
      branchPrefix: 'catalog-update'
    })

    expect(result.branch).toBe('catalog-update-override/vulnerability-fixes')
  })

  test('singular title for one dependency', () => {
    const overrides: OverrideEntry[] = [{
      packageName: 'lodash',
      vulnerableRange: '<4.17.21',
      fixedVersion: '4.17.21',
      advisories: [makeAdvisory()]
    }]

    const result = buildOverrideBranchUpdate({
      overrides,
      branchPrefix: 'catalog-update'
    })

    expect(result.title).toBe('fix(security): override 1 vulnerable transitive dependency')
  })

  test('plural title for multiple dependencies', () => {
    const overrides: OverrideEntry[] = [
      { packageName: 'lodash', vulnerableRange: '<4.17.21', fixedVersion: '4.17.21', advisories: [makeAdvisory()] },
      { packageName: 'minimist', vulnerableRange: '<1.2.6', fixedVersion: '1.2.6', advisories: [makeAdvisory()] }
    ]

    const result = buildOverrideBranchUpdate({
      overrides,
      branchPrefix: 'catalog-update'
    })

    expect(result.title).toBe('fix(security): override 2 vulnerable transitive dependencies')
  })

  test('applyChanges uses scoped keys and preserves existing', () => {
    const overrides: OverrideEntry[] = [{
      packageName: 'lodash',
      vulnerableRange: '<4.17.21',
      fixedVersion: '4.17.21',
      advisories: [makeAdvisory()]
    }]

    const result = buildOverrideBranchUpdate({
      overrides,
      branchPrefix: 'catalog-update'
    })

    const pkg: Record<string, unknown> = { overrides: { 'minimist@<1.2.6': '1.2.6' } }
    result.applyChanges(pkg)

    const applied = pkg.overrides as Record<string, string>
    expect(applied['lodash@<4.17.21']).toBe('4.17.21')
    expect(applied['minimist@<1.2.6']).toBe('1.2.6')
  })
})

// ---------------------------------------------------------------------------
// isOverrideBranchOutdated
// ---------------------------------------------------------------------------

describe('isOverrideBranchOutdated', () => {
  const expectedOverrides: OverrideEntry[] = [
    {
      packageName: 'lodash',
      vulnerableRange: '<4.17.21',
      fixedVersion: '4.17.21',
      advisories: [makeAdvisory()]
    }
  ]

  test('returns true when overrides field missing', () => {
    const result = isOverrideBranchOutdated({
      branchPackageJson: {},
      expectedOverrides
    })
    expect(result).toBe(true)
  })

  test('returns false when overrides match (scoped key)', () => {
    const result = isOverrideBranchOutdated({
      branchPackageJson: { overrides: { 'lodash@<4.17.21': '4.17.21' } },
      expectedOverrides
    })
    expect(result).toBe(false)
  })

  test('returns true when override values are stale', () => {
    const result = isOverrideBranchOutdated({
      branchPackageJson: { overrides: { 'lodash@<4.17.21': '4.17.19' } },
      expectedOverrides
    })
    expect(result).toBe(true)
  })
})
