import type { BranchUpdate, Config, ExistingPr, UpdateCandidate, VersionReleaseNote } from './types'
import { formatReleaseNotes } from './registry'
import { getOverrideBranchPrefix, PR_FOOTER } from './utils'

// ---------------------------------------------------------------------------
// Shell execution
// ---------------------------------------------------------------------------

export async function exec({
  command,
  cwd
}: {
  command: string[]
  cwd: string
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env
  })

  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    console.error(`  Command failed: ${command.join(' ')}`)
    if (stderr.trim()) console.error(`  stderr: ${stderr.trim()}`)
  }

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

// ---------------------------------------------------------------------------
// Install command
// ---------------------------------------------------------------------------

function getInstallCommand({ packageManager }: { packageManager: Config['packageManager'] }): string[] {
  switch (packageManager) {
    case 'bun': return ['bun', 'install']
    case 'npm': return ['npm', 'install']
    case 'pnpm': return ['pnpm', 'install']
    case 'yarn': return ['yarn', 'install']
  }
}

// ---------------------------------------------------------------------------
// Catalog PR body
// ---------------------------------------------------------------------------

export function buildCatalogPrBody({
  updates,
  releaseNotes
}: {
  updates: UpdateCandidate[]
  releaseNotes: Map<string, VersionReleaseNote[]>
}): string {
  const sorted = [...updates].sort((a, b) => a.name.localeCompare(b.name))

  const lines = [
    '## Dependency Updates',
    '',
    '| Package | From | To | Type |',
    '| --- | --- | --- | --- |',
    ...sorted.map((u) => `| \`${u.name}\` | ${u.currentVersion} | ${u.latestVersion} | ${u.changeType} |`)
  ]

  lines.push(...formatReleaseNotes({ updates, releaseNotes }))
  lines.push('---', PR_FOOTER)

  return lines.join('\n')
}

export function buildCatalogValue({ update }: { update: UpdateCandidate }): string {
  if (update.isAlias) {
    return `npm:${update.aliasName}@${update.latestVersion}`
  }
  return update.hasCaret ? `^${update.latestVersion}` : update.latestVersion
}

// ---------------------------------------------------------------------------
// Catalog BranchUpdate builder
// ---------------------------------------------------------------------------

export function buildCatalogBranchUpdate({
  groupName,
  updates,
  config,
  releaseNotes
}: {
  groupName: string
  updates: UpdateCandidate[]
  config: Config
  releaseNotes: Map<string, VersionReleaseNote[]>
}): BranchUpdate {
  const branch = `${config.branchPrefix}/${groupName}`
  const first = updates[0]
  const title =
    first && updates.length === 1
      ? `chore(deps): bump ${first.name} from ${first.currentVersion} to ${first.latestVersion}`
      : `chore(deps): bump ${groupName} dependencies`
  const body = buildCatalogPrBody({ updates, releaseNotes })

  return {
    branch,
    title,
    body,
    applyChanges: (packageJson: Record<string, unknown>) => {
      const catalog = packageJson.catalog as Record<string, string> | undefined
      if (!catalog || typeof catalog !== 'object') {
        throw new Error(`No valid catalog found in package.json`)
      }
      for (const update of updates) {
        catalog[update.name] = buildCatalogValue({ update })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Existing PRs
// ---------------------------------------------------------------------------

export async function getExistingPrs({
  cwd,
  branchPrefix
}: {
  cwd: string
  branchPrefix: string
}): Promise<ExistingPr[]> {
  const { stdout } = await exec({
    command: [
      'gh', 'pr', 'list',
      '--state', 'open',
      '--search', `head:${branchPrefix}`,
      '--json', 'headRefName,number,mergeable,title',
      '--limit', '100'
    ],
    cwd
  })

  try {
    const prs = JSON.parse(stdout || '[]') as ExistingPr[]
    return prs.filter((pr) => pr.headRefName.startsWith(`${branchPrefix}/`) || pr.headRefName.startsWith(`${getOverrideBranchPrefix({ branchPrefix })}/`))
  } catch {
    return []
  }
}

export async function hasNonBotCommits({ pr, cwd }: { pr: ExistingPr; cwd: string }): Promise<boolean> {
  const { stdout, exitCode } = await exec({
    command: ['gh', 'pr', 'view', String(pr.number), '--json', 'commits'],
    cwd
  })

  if (exitCode !== 0) return true

  try {
    const data = JSON.parse(stdout) as { commits: Array<{ authors: Array<{ login: string }> }> }
    return data.commits.some((commit) => commit.authors.some((author) => author.login !== 'github-actions[bot]'))
  } catch {
    return true
  }
}

export async function resolveMergeableState({ pr, cwd }: { pr: ExistingPr; cwd: string }): Promise<ExistingPr['mergeable']> {
  if (pr.mergeable !== 'UNKNOWN') return pr.mergeable

  console.log(`  PR #${pr.number} has UNKNOWN mergeable state, retrying in 5s...`)
  await Bun.sleep(5000)

  const { stdout, exitCode } = await exec({
    command: ['gh', 'pr', 'view', String(pr.number), '--json', 'mergeable'],
    cwd
  })

  if (exitCode !== 0) return 'UNKNOWN'

  try {
    const data = JSON.parse(stdout) as { mergeable: ExistingPr['mergeable'] }
    return data.mergeable
  } catch {
    return 'UNKNOWN'
  }
}

// ---------------------------------------------------------------------------
// Branch operations
// ---------------------------------------------------------------------------

export async function isBranchBehindDefault({
  branch,
  defaultBranch,
  cwd
}: {
  branch: string
  defaultBranch: string
  cwd: string
}): Promise<boolean> {
  const { stdout, exitCode } = await exec({
    command: ['git', 'rev-list', '--count', `origin/${branch}..origin/${defaultBranch}`],
    cwd
  })

  if (exitCode !== 0) return true
  return Number(stdout) > 0
}

export async function readBranchPackageJson({
  branch,
  cwd
}: {
  branch: string
  cwd: string
}): Promise<Record<string, unknown> | null> {
  const { stdout, exitCode } = await exec({
    command: ['git', 'show', `origin/${branch}:package.json`],
    cwd
  })

  if (exitCode !== 0) return null

  try {
    return JSON.parse(stdout) as Record<string, unknown>
  } catch {
    return null
  }
}

async function returnToDefault({ defaultBranch, cwd }: { defaultBranch: string; cwd: string }): Promise<void> {
  await exec({ command: ['git', 'checkout', '--', '.'], cwd })
  const { exitCode } = await exec({ command: ['git', 'checkout', defaultBranch], cwd })
  if (exitCode !== 0) {
    throw new Error(`Fatal: failed to return to ${defaultBranch} branch. Aborting remaining groups.`)
  }
}

// ---------------------------------------------------------------------------
// Generic branch update + PR creation
// ---------------------------------------------------------------------------

export async function updateBranch({
  branchUpdate,
  config,
  cwd,
  packageJsonPath
}: {
  branchUpdate: BranchUpdate
  config: Config
  cwd: string
  packageJsonPath: string
}): Promise<{ success: boolean }> {
  const { branch, title, applyChanges } = branchUpdate

  const checkoutResult = await exec({
    command: ['git', 'checkout', '-B', branch, `origin/${config.defaultBranch}`],
    cwd
  })
  if (checkoutResult.exitCode !== 0) return { success: false }

  const packageJson = await Bun.file(packageJsonPath).json()

  try {
    applyChanges(packageJson)
  } catch (error: unknown) {
    console.error(`  ${String(error)}`)
    await returnToDefault({ defaultBranch: config.defaultBranch, cwd })
    return { success: false }
  }

  await Bun.write(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)

  console.log('  Running install...')
  const installResult = await exec({ command: getInstallCommand({ packageManager: config.packageManager }), cwd })
  if (installResult.exitCode !== 0) {
    console.error(`  Failed to run install for branch "${branch}"`)
    await returnToDefault({ defaultBranch: config.defaultBranch, cwd })
    return { success: false }
  }

  const { stdout: diffFiles } = await exec({ command: ['git', 'diff', '--name-only'], cwd })
  const lockfileNames = new Set(['package.json', 'bun.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])
  const unexpectedFiles = diffFiles.split('\n').filter((f) => f && !lockfileNames.has(f))
  if (unexpectedFiles.length > 0) {
    console.warn(`  Warning: install modified unexpected files: ${unexpectedFiles.join(', ')}`)
  }

  const filesToStage = ['package.json', ...diffFiles.split('\n').filter(Boolean)]
  await exec({ command: ['git', 'add', ...filesToStage], cwd })

  // --no-verify: skip pre-commit hooks since this is an automated action
  const commitResult = await exec({ command: ['git', 'commit', '--no-verify', '-m', title], cwd })
  if (commitResult.exitCode !== 0) {
    console.error(`  Failed to commit for branch "${branch}"`)
    await returnToDefault({ defaultBranch: config.defaultBranch, cwd })
    return { success: false }
  }

  const pushResult = await exec({
    command: ['git', 'push', `--force-with-lease=${branch}`, 'origin', branch],
    cwd
  })
  if (pushResult.exitCode !== 0) {
    console.error(`  Failed to push branch "${branch}"`)
    await returnToDefault({ defaultBranch: config.defaultBranch, cwd })
    return { success: false }
  }

  await returnToDefault({ defaultBranch: config.defaultBranch, cwd })
  return { success: true }
}

export async function createPr({
  branchUpdate,
  config,
  cwd,
  packageJsonPath
}: {
  branchUpdate: BranchUpdate
  config: Config
  cwd: string
  packageJsonPath: string
}): Promise<boolean> {
  console.log(`\n  Creating PR for branch "${branchUpdate.branch}"`)

  const result = await updateBranch({ branchUpdate, config, cwd, packageJsonPath })
  if (!result.success) return false

  const prResult = await exec({
    command: [
      'gh', 'pr', 'create',
      '--base', config.defaultBranch,
      '--head', branchUpdate.branch,
      '--title', branchUpdate.title,
      '--body', branchUpdate.body
    ],
    cwd
  })

  if (prResult.exitCode === 0) {
    console.log(`  PR created: ${prResult.stdout}`)
  } else {
    console.error(`  Failed to create PR for branch "${branchUpdate.branch}"`)
    if (prResult.stderr?.includes('not permitted to create or approve pull requests')) {
      console.error('  Enable "Allow GitHub Actions to create and approve pull requests" in repository Settings > Actions > General > Workflow permissions.')
      console.error('  If the checkbox is disabled, an organization admin must first enable it in Organization Settings > Actions > General > Workflow permissions.')
    }
  }

  return prResult.exitCode === 0
}

export async function syncExistingPrs({
  existingPrs,
  resolveBranchUpdate,
  isBranchContentOutdated,
  config,
  cwd,
  packageJsonPath
}: {
  existingPrs: ExistingPr[]
  resolveBranchUpdate: (branchName: string) => BranchUpdate | null
  isBranchContentOutdated: (branchPackageJson: Record<string, unknown>, branchName: string) => boolean
  config: Config
  cwd: string
  packageJsonPath: string
}): Promise<{ closedCount: number; rebuiltCount: number }> {
  if (existingPrs.length === 0) {
    console.log('  No existing PRs to sync')
    return { closedCount: 0, rebuiltCount: 0 }
  }

  console.log(`  Syncing ${existingPrs.length} existing PR(s)`)

  const nonBotResults = new Map<number, boolean>()
  await Promise.all(
    existingPrs.map(async (pr) => {
      nonBotResults.set(pr.number, await hasNonBotCommits({ pr, cwd }))
    })
  )

  let closedCount = 0
  let rebuiltCount = 0

  for (const pr of existingPrs) {
    if (nonBotResults.get(pr.number)) {
      console.log(`  Skipping PR #${pr.number} — has non-bot commits`)
      continue
    }

    const branchUpdate = resolveBranchUpdate(pr.headRefName)

    if (!branchUpdate) {
      console.log(`  Closing stale PR #${pr.number} — no longer needed`)
      const closeResult = await exec({
        command: [
          'gh', 'pr', 'close', String(pr.number),
          '--comment', 'Closing: all packages in this group are already up to date.'
        ],
        cwd
      })
      if (closeResult.exitCode === 0) {
        closedCount++
      }
      continue
    }

    const mergeable = await resolveMergeableState({ pr, cwd })
    const isConflicting = mergeable === 'CONFLICTING'
    const behindDefault =
      !isConflicting && (await isBranchBehindDefault({ branch: pr.headRefName, defaultBranch: config.defaultBranch, cwd }))

    let hasContentChanges = false
    if (!isConflicting && !behindDefault) {
      const branchPkg = await readBranchPackageJson({ branch: pr.headRefName, cwd })
      hasContentChanges = !branchPkg || isBranchContentOutdated(branchPkg, pr.headRefName)
    }

    if (!isConflicting && !behindDefault && !hasContentChanges) {
      console.log(`  PR #${pr.number} (${pr.headRefName}) is up to date`)
      continue
    }

    let reason = 'outdated content'
    if (isConflicting) reason = 'conflicting'
    else if (behindDefault) reason = `behind ${config.defaultBranch}`
    console.log(`\n  Rebuilding PR #${pr.number} (${pr.headRefName}) — ${reason}`)

    try {
      const result = await updateBranch({ branchUpdate, config, cwd, packageJsonPath })
      if (!result.success) {
        console.error(`  Failed to rebuild PR #${pr.number} (${pr.headRefName})`)
        continue
      }

      const editResult = await exec({
        command: ['gh', 'pr', 'edit', String(pr.number), '--title', branchUpdate.title, '--body', branchUpdate.body],
        cwd
      })

      if (editResult.exitCode !== 0) {
        console.warn(`  Warning: Failed to update title/body for PR #${pr.number}, but branch was rebuilt`)
      }

      console.log(`  Successfully rebuilt PR #${pr.number} (${pr.headRefName})`)
      rebuiltCount++
    } catch (error: unknown) {
      console.error(`  Error rebuilding PR #${pr.number} (${pr.headRefName}): ${String(error)}`)
    }
  }

  return { closedCount, rebuiltCount }
}
