import { describe, expect, test } from 'bun:test'
import { clampNoteBody, escapeMentions, formatReleaseNotes } from '../src/release-notes'
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

describe('escapeMentions', () => {
  test('defuses user and team mentions', () => {
    expect(escapeMentions('thanks @octocat and @acme/core!')).toBe(
      'thanks @<!---->octocat and @<!---->acme/core!'
    )
  })

  test('defuses a mention at the start of the body', () => {
    expect(escapeMentions('@octocat opened this')).toBe('@<!---->octocat opened this')
  })

  test('leaves emails alone', () => {
    expect(escapeMentions('mail a@b.com about it')).toBe('mail a@b.com about it')
  })

  test('leaves inline code spans untouched', () => {
    expect(escapeMentions('install with `npm i @types/node` today')).toBe(
      'install with `npm i @types/node` today'
    )
  })

  test('defuses a mention that follows a code span', () => {
    expect(escapeMentions('`npm i x` @octocat')).toBe('`npm i x` @<!---->octocat')
  })

  test('leaves fenced code blocks untouched, defuses prose after them', () => {
    const body = '```ts\nconst x = "@octocat"\n```\nthanks @maintainer'
    expect(escapeMentions(body)).toBe('```ts\nconst x = "@octocat"\n```\nthanks @<!---->maintainer')
  })

  test('leaves tilde fences untouched', () => {
    const body = '~~~\npnpm add @scope/pkg\n~~~'
    expect(escapeMentions(body)).toBe(body)
  })

  test('keeps a code span open across lines intact', () => {
    expect(escapeMentions('`code\nspan` @octocat')).toBe('`code\nspan` @<!---->octocat')
  })

  test('treats an unclosed backtick run as prose', () => {
    expect(escapeMentions('`unclosed @octocat')).toBe('`unclosed @<!---->octocat')
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

  test('defuses mentions in rendered note bodies', () => {
    const notes = new Map<string, Array<VersionReleaseNote>>([
      ['react', [{ version: '19.0.0', body: 'thanks @octocat' }]]
    ])
    const lines = formatReleaseNotes({
      updates: [makeCandidate({ name: 'react' })],
      releaseNotes: notes
    })
    expect(lines).toContain('thanks @<!---->octocat')
  })

  test('defuses scoped package names in section summaries', () => {
    const notes = new Map<string, Array<VersionReleaseNote>>([
      ['@scope/pkg', [{ version: '2.0.0', body: 'shipped' }]]
    ])
    const lines = formatReleaseNotes({
      updates: [makeCandidate({ name: '@scope/pkg' })],
      releaseNotes: notes
    })
    expect(lines).toContain(
      '<summary><b>@<!---->scope/pkg</b> (1.0.0 → 2.0.0)</summary>'
    )
  })

  test('leaves code in note bodies intact when defusing mentions', () => {
    const notes = new Map<string, Array<VersionReleaseNote>>([
      ['react', [{ version: '19.0.0', body: 'run `npm i @types/node`, thanks @octocat' }]]
    ])
    const lines = formatReleaseNotes({
      updates: [makeCandidate({ name: 'react' })],
      releaseNotes: notes
    })
    expect(lines).toContain('run `npm i @types/node`, thanks @<!---->octocat')
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
