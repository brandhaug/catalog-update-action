import { describe, expect, test } from 'bun:test'
import { Option, Schema } from 'effect'
import { githubReleasesSchema, parseGitHubRepo } from '../src/registry'

const decodeReleases = Schema.decodeUnknownOption(githubReleasesSchema)

describe('parseGitHubRepo', () => {
  test('parses https URLs', () => {
    expect(parseGitHubRepo({ url: 'https://github.com/owner/repo' })).toEqual({
      owner: 'owner',
      repo: 'repo'
    })
  })

  test('parses git+https URLs with .git suffix', () => {
    expect(
      parseGitHubRepo({ url: 'git+https://github.com/owner/repo.git' })
    ).toEqual({ owner: 'owner', repo: 'repo' })
  })

  test('parses ssh URLs', () => {
    expect(parseGitHubRepo({ url: 'git@github.com:owner/repo.git' })).toEqual({
      owner: 'owner',
      repo: 'repo'
    })
  })

  test('keeps dots and dashes in names', () => {
    expect(
      parseGitHubRepo({ url: 'https://github.com/effect-ts/effect' })
    ).toEqual({ owner: 'effect-ts', repo: 'effect' })
  })

  test('returns null for non-GitHub URLs', () => {
    expect(parseGitHubRepo({ url: 'https://gitlab.com/owner/repo' })).toBeNull()
    expect(parseGitHubRepo({ url: '' })).toBeNull()
  })
})

describe('githubReleasesSchema', () => {
  test('accepts null bodies (GitHub emits them for body-less releases)', () => {
    const decoded = decodeReleases([
      { tag_name: 'v1.0.0', body: null, html_url: 'https://example.com' },
      { tag_name: 'v1.1.0', body: 'notes', html_url: 'https://example.com' }
    ])
    expect(Option.isNone(decoded)).toBe(false)
  })

  test('accepts omitted bodies', () => {
    const decoded = decodeReleases([{ tag_name: 'v1.0.0' }])
    expect(Option.isNone(decoded)).toBe(false)
  })

  test('rejects non-string non-null bodies', () => {
    const decoded = decodeReleases([{ tag_name: 'v1.0.0', body: 42 }])
    expect(Option.isNone(decoded)).toBe(true)
  })
})
