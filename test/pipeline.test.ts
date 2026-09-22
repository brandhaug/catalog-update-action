import { afterEach, expect, test } from 'bun:test'
import { Effect, Logger } from 'effect'
import { BunFileSystem } from '@effect/platform-bun'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processCatalogScope } from '../src/pipeline'
import { resolveCatalogScopes } from '../src/scopes'
import { Commands } from '../src/commands'
import { Registry } from '../src/registry'
import { type CatalogLocation } from '../src/types'

const dirs: Array<string> = []
afterEach(async () => { await Effect.runPromise(Effect.forEach(dirs.splice(0), dir => Effect.promise(() => rm(dir, { recursive: true, force: true })), { concurrency: "unbounded" })) })

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'catalog-pipeline-'))
  dirs.push(cwd)
  await mkdir(join(cwd, 'milkyway'))
  await writeFile(join(cwd, '.catalog-updaterc.json'), JSON.stringify({ audit: { enabled: false }, groups: [{ name: 'tooling', patterns: ['typescript', 'oxlint'] }] }))
  const locations: Array<CatalogLocation> = [
    { dir: '.', providerId: 'bun', definitionRelPath: 'package.json', definition: { catalogName: 'default', entries: { typescript: '5.0.0' } } },
    { dir: 'milkyway', providerId: 'bun', definitionRelPath: 'milkyway/package.json', definition: { catalogName: 'default', entries: { typescript: '5.0.0', oxlint: '1.0.0' } } }
  ]
  await Effect.runPromise(Effect.forEach(locations, l => Effect.promise(() => writeFile(join(cwd, l.definitionRelPath), JSON.stringify({ catalog: l.definition.entries }))), { concurrency: "unbounded" }))
  return { cwd, locations }
}

const registry = Registry.of({
  queryNpmRegistry: ({ entries }) => Effect.succeed(new Map(entries.map(e => [e.name, e.name === 'typescript' ? '5.1.0' : '1.1.0']))),
  queryPackageMetadata: () => Effect.succeed(new Map()),
  queryReleaseNotes: () => Effect.succeed(new Map())
})

test('one grouped PR updates shared pins in both workspaces and installs both before commit', async () => {
  const { cwd, locations } = await fixture()
  const calls: Array<{ command: Array<string>, cwd: string }> = []
  const commands = Commands.of({ exec: (command, options) => Effect.sync(() => {
    calls.push({ command, cwd: options.cwd })
    let stdout = ''
    if (command.slice(0, 3).join(' ') === 'gh pr list') { stdout = '[]' }
    if (command.slice(0, 3).join(' ') === 'git diff --name-only') { stdout = 'package.json\nbun.lock\nmilkyway/package.json\nmilkyway/bun.lock' }
    return { stdout, stderr: '', exitCode: 0 }
  }) })
  const result = await Effect.runPromise(Effect.gen(function* () {
    const scopes = yield* resolveCatalogScopes({ cwd, locations, configPath: '.catalog-updaterc.json' })
    const scope = scopes[0]
    if (!scope) {throw new Error('No scope')}
    return yield* processCatalogScope({ cwd, scope, dryRun: false })
  }).pipe(Effect.provide(BunFileSystem.layer), Effect.provide(Logger.layer([])), Effect.provideService(Commands, commands), Effect.provideService(Registry, registry)))
  expect(result).toEqual({ created: 1, failed: 0, rebuilt: 0 })
  expect(JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).catalog).toEqual({ typescript: '5.1.0' })
  expect(JSON.parse(await readFile(join(cwd, 'milkyway/package.json'), 'utf8')).catalog).toEqual({ typescript: '5.1.0', oxlint: '1.1.0' })
  expect(calls.filter(c => c.command.join(' ') === 'bun install').map(c => c.cwd)).toEqual([cwd, `${cwd}/milkyway`])
  const commitIndex = calls.findIndex(c => c.command[1] === 'commit')
  expect(calls.findLastIndex(c => c.command.join(' ') === 'bun install')).toBeLessThan(commitIndex)
  expect(calls.filter(c => c.command.slice(0, 3).join(' ') === 'gh pr create')).toHaveLength(1)
  expect(calls.find(c => c.command[1] === 'add')?.command).toContain('milkyway/bun.lock')
})

async function runFixture({ cwd, locations, commands, registryService = registry }: {
  cwd: string
  locations: Array<CatalogLocation>
  commands: Commands['Service']
  registryService?: Registry['Service']
}) {
  return Effect.runPromise(Effect.gen(function* () {
    const scopes = yield* resolveCatalogScopes({ cwd, locations, configPath: '.catalog-updaterc.json' })
    const scope = scopes[0]
    if (!scope) { throw new Error('No scope') }
    return yield* processCatalogScope({ cwd, scope, dryRun: false })
  }).pipe(Effect.provide(BunFileSystem.layer), Effect.provide(Logger.layer([])), Effect.provideService(Commands, commands), Effect.provideService(Registry, registryService)))
}

test('a skipped member prevents partial grouped updates in the other workspace', async () => {
  const { cwd, locations } = await fixture()
  let query = 0
  const registryService = Registry.of({ ...registry, queryNpmRegistry: ({ entries }) => Effect.sync(() => {
    query++
    return new Map(entries.filter(entry => query === 1 || entry.name !== 'typescript').map(entry => [entry.name, entry.name === 'typescript' ? '5.1.0' : '1.1.0']))
  }) })
  const creates: Array<Array<string>> = []
  const commands = Commands.of({ exec: command => Effect.sync(() => {
    if (command.slice(0, 3).join(' ') === 'gh pr create') { creates.push(command) }
    return { stdout: '[]', stderr: '', exitCode: 0 }
  }) })
  await runFixture({ cwd, locations, commands, registryService })
  expect(creates).toHaveLength(0)
})

test('failure in the second install restores both manifests without committing or pushing', async () => {
  const { cwd, locations } = await fixture()
  const { spawnSync } = await import('node:child_process')
  const git = (args: Array<string>) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (result.status !== 0) { throw new Error(result.stderr) }
    return result.stdout.trim()
  }
  git(['init', '-b', 'master'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['add', '.'])
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'])
  const initial = git(['rev-parse', 'HEAD'])
  git(['update-ref', 'refs/remotes/origin/master', initial])
  const published: Array<Array<string>> = []
  const commands = Commands.of({ exec: (command, options) => Effect.sync(() => {
    if (command[0] === 'git' && command[1] !== 'push') {
      const result = spawnSync('git', command.slice(1), { cwd: options.cwd, encoding: 'utf8' })
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 }
    }
    if (command[0] === 'bun') { return { stdout: '', stderr: 'install failed', exitCode: options.cwd.endsWith('/milkyway') ? 1 : 0 } }
    if (command[1] === 'push' || command[2] === 'create') { published.push(command) }
    return { stdout: '[]', stderr: '', exitCode: 0 }
  }) })
  const result = await runFixture({ cwd, locations, commands })
  expect(result).toEqual({ created: 0, failed: 1, rebuilt: 0 })
  expect(published).toHaveLength(0)
  expect(git(['rev-parse', 'HEAD'])).toBe(initial)
  expect(git(['status', '--porcelain'])).toBe('')
  expect(JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).catalog.typescript).toBe('5.0.0')
  expect(JSON.parse(await readFile(join(cwd, 'milkyway/package.json'), 'utf8')).catalog.typescript).toBe('5.0.0')
})

test('sync repairs a shared PR when only the nested manifest has drifted', async () => {
  const { cwd, locations } = await fixture()
  const calls: Array<Array<string>> = []
  const commands = Commands.of({ exec: command => Effect.sync(() => {
    calls.push(command)
    let stdout = ''
    if (command.slice(0, 3).join(' ') === 'gh pr list') { stdout = JSON.stringify([{ headRefName: 'catalog-update/tooling', number: 1, mergeable: 'MERGEABLE', title: 'deps' }]) }
    if (command.slice(0, 2).join(' ') === 'gh api') { stdout = '[]' }
    if (command[1] === 'rev-list') { stdout = '0' }
    if (command[1] === 'show') { stdout = JSON.stringify({ catalog: command[2]?.endsWith(':package.json') ? { typescript: '5.1.0' } : { typescript: '5.0.0', oxlint: '1.1.0' } }) }
    return { stdout, stderr: '', exitCode: 0 }
  }) })
  const result = await runFixture({ cwd, locations, commands })
  expect(result.rebuilt).toBe(1)
  expect(calls.some(command => command[1] === 'show' && command[2] === 'origin/catalog-update/tooling:milkyway/package.json')).toBe(true)
  expect(calls.filter(command => command[1] === 'push')).toHaveLength(1)
  expect(calls.filter(command => command.slice(0, 3).join(' ') === 'gh pr create')).toHaveLength(0)
})

test('moving config to root rebuilds an existing nested PR with both catalogs', async () => {
  const { cwd, locations } = await fixture()
  const calls: Array<Array<string>> = []
  const commands = Commands.of({ exec: command => Effect.sync(() => {
    calls.push(command)
    let stdout = ''
    if (command.slice(0, 3).join(' ') === 'gh pr list') { stdout = JSON.stringify([{ headRefName: 'catalog-update/milkyway/tooling', number: 2, mergeable: 'CONFLICTING', title: 'deps' }]) }
    if (command.slice(0, 2).join(' ') === 'gh api') { stdout = '[]' }
    return { stdout, stderr: '', exitCode: 0 }
  }) })
  const result = await runFixture({ cwd, locations, commands })
  expect(result).toEqual({ created: 0, failed: 0, rebuilt: 1 })
  expect(calls.filter(command => command.slice(0, 3).join(' ') === 'gh pr create')).toHaveLength(0)
  expect(calls.find(command => command[1] === 'push')).toContain('catalog-update/milkyway/tooling')
  expect(JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).catalog.typescript).toBe('5.1.0')
})

test('independently configured nested PRs are never synced or counted against root limit', async () => {
  const { cwd, locations } = await fixture()
  await writeFile(join(cwd, '.catalog-updaterc.json'), JSON.stringify({ maxOpenPrs: 1, audit: { enabled: false } }))
  await writeFile(join(cwd, 'milkyway/.catalog-updaterc.json'), JSON.stringify({ audit: { enabled: false } }))
  const calls: Array<Array<string>> = []
  const commands = Commands.of({ exec: command => Effect.sync(() => {
    calls.push(command)
    const stdout = command.slice(0, 3).join(' ') === 'gh pr list' ? JSON.stringify([{ headRefName: 'catalog-update/milkyway/tooling', number: 2, mergeable: 'CONFLICTING', title: 'deps' }]) : ''
    return { stdout, stderr: '', exitCode: 0 }
  }) })
  const result = await runFixture({ cwd, locations, commands })
  expect(result.created).toBe(1)
  expect(calls.filter(command => command.slice(0, 3).join(' ') === 'gh pr close')).toHaveLength(0)
  expect(calls.filter(command => command.slice(0, 2).join(' ') === 'gh api')).toHaveLength(0)
  expect(JSON.parse(await readFile(join(cwd, 'milkyway/package.json'), 'utf8')).catalog.typescript).toBe('5.0.0')
})
