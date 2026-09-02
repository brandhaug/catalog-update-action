import { describe, expect, test } from 'bun:test'
import { parseGitHubRepo } from '../src/registry'

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
