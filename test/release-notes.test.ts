import { describe, expect, test } from 'bun:test'
import { clampNoteBody, formatReleaseNotes } from '../src/release-notes'
import { type UpdateCandidate, type VersionReleaseNote } from '../src/types'

function makeCandidate(overrides: Partial<UpdateCandidate> & { name: string }): UpdateCandidate {
  return {
    npmName: overrides.name,
    currentVersion: '1.0.0',
    latestVersion: '2.0.0',
    changeType: 'major',
    rangePrefix: '',
    isAlias: false,
    ...overrides
  }
}

describe('clampNoteBody', () => {
  test('returns short bodies unchanged', () => {
    expect(clampNoteBody({ body: 'short note', releaseUrl: 'https://x' })).toBe('short note')
  })

  test('truncates long bodies and links to the full notes', () => {
    const body = 'x'.repeat(5000)
    const clamped = clampNoteBody({ body, releaseUrl: 'https://x/releases' })
    expect(clamped.length).toBeLessThan(body.length)
    expect(clamped).toContain('…[full notes](https://x/releases)')
  })
})

describe('formatReleaseNotes', () => {
  test('returns no lines when no notes exist', () => {
    const lines = formatReleaseNotes({
      updates: [makeCandidate({ name: 'react' })],
      releaseNotes: new Map()
    })
    expect(lines).toEqual([])
  })

  test('renders a single note as one collapsible section', () => {
    const notes = new Map<string, Array<VersionReleaseNote>>([
      ['react', [{ version: '19.0.0', body: 'React 19 is here!' }]]
    ])
    const lines = formatReleaseNotes({
      updates: [makeCandidate({ name: 'react' })],
      releaseNotes: notes
    })
    expect(lines).toContain('## Release Notes')
    expect(lines).toContain('React 19 is here!')
  })

  test('stops adding notes once the combined limit is reached', () => {
    const body = 'y'.repeat(3000)
    const notes = new Map<string, Array<VersionReleaseNote>>([
      [
        'react',
        [
          { version: '19.0.2', body },
          { version: '19.0.1', body },
          { version: '19.0.0', body }
        ]
      ]
    ])
    const lines = formatReleaseNotes({
      updates: [makeCandidate({ name: 'react' })],
      releaseNotes: notes
    })
    // First 3000-char note renders (cumulative 3000 ≤ 5000); the second
    // would exceed the 5000 limit, so both remaining notes are cut.
    expect(lines).toContain('<p><i>…and 2 more release(s) not shown</i></p>')
  })
})
