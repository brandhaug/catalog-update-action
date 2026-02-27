import { loadConfig } from './config'
import { parseCatalog } from './catalog'
import { queryNpmRegistry, queryPackageMetadata, queryReleaseNotes } from './registry'
import { shouldIgnore, assignToGroups } from './groups'
import { getExistingPrs, syncExistingPrs, createGroupPr } from './git'
import { classifySemverChange, Semaphore } from './utils'
import type { UpdateCandidate } from './types'

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { dryRun: boolean; configPath: string } {
  const args = process.argv.slice(2)
  let configPath = '.catalog-updaterc.json'
  let dryRun = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--config' && args[i + 1] !== undefined) {
      configPath = args[i + 1] as string
      i++
    }
  }

  return { dryRun, configPath }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { dryRun, configPath } = parseArgs()
  const cwd = process.cwd()
  const packageJsonPath = `${cwd}/package.json`

  console.log('Catalog Dependency Updater')
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`)
  console.log(`Config: ${configPath}`)
  console.log('')

  // 1. Load config
  console.log('1. Loading config...')
  const config = await loadConfig({ configPath: `${cwd}/${configPath}` })
  console.log(`  Branch prefix: ${config.branchPrefix}`)
  console.log(`  Default branch: ${config.defaultBranch}`)
  console.log(`  Package manager: ${config.packageManager}`)
  console.log(`  Groups: ${config.groups.length}`)
  console.log(`  Ignore rules: ${config.ignore.length}`)

  // 2. Parse catalog
  console.log('\n2. Parsing catalog...')
  const packageJson = await Bun.file(packageJsonPath).json()
  const catalog = packageJson.catalog as Record<string, string> | undefined

  if (!catalog) {
    console.error('No catalog found in package.json')
    process.exit(1)
  }

  const entries = parseCatalog({ catalog })
  console.log(`  Found ${entries.length} catalog entries (skipped pre-release versions)`)

  // 3. Query npm registry
  console.log('\n3. Querying npm registry...')
  const semaphore = new Semaphore(config.concurrency)
  const latestVersions = await queryNpmRegistry({ entries, semaphore })
  console.log(`  Got latest versions for ${latestVersions.size} packages`)

  // 4. Find updates
  console.log('\n4. Finding available updates...')
  const candidates: UpdateCandidate[] = []

  for (const entry of entries) {
    const latest = latestVersions.get(entry.name)
    if (!latest) continue

    const changeType = classifySemverChange({ from: entry.currentVersion, to: latest })
    if (changeType === null) continue

    if (shouldIgnore({ name: entry.name, changeType, rules: config.ignore })) {
      continue
    }

    candidates.push({ ...entry, latestVersion: latest, changeType })
  }

  console.log(`  Found ${candidates.length} packages with updates`)

  if (candidates.length === 0) {
    console.log('\nNo updates available. Done!')
    return
  }

  // 4b. Fetch package metadata and release notes
  console.log('\n4b. Fetching package metadata (repo URLs + published versions)...')
  const packageMetadata = await queryPackageMetadata({ candidates, semaphore })
  console.log(`  Found metadata for ${packageMetadata.size}/${candidates.length} packages`)

  console.log('\n4c. Fetching release notes (multi-version)...')
  const releaseNotes = await queryReleaseNotes({ candidates, packageMetadata, semaphore })
  console.log(`  Found release notes for ${releaseNotes.size}/${candidates.length} packages`)

  // 5. Group updates
  console.log('\n5. Grouping updates...')
  const groups = assignToGroups({ candidates, groups: config.groups })

  // Create individual PRs for candidates not matched by any group
  const assignedNames = new Set([...groups.values()].flat().map((u) => u.name))
  const unassigned = candidates.filter((c) => !assignedNames.has(c.name))
  for (const candidate of unassigned) {
    const sanitizedName = candidate.name.replace(/^@/, '').replaceAll('/', '-')
    groups.set(sanitizedName, [candidate])
  }

  for (const [groupName, updates] of groups) {
    const types = [...new Set(updates.map((u) => u.changeType))].join(', ')
    console.log(`  ${groupName}: ${updates.map((u) => u.name).join(', ')} (${types})`)
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] Would create ${groups.size} PRs for the above groups. Exiting.`)
    return
  }

  // 6. Check existing PRs
  console.log('\n6. Checking existing PRs...')
  const existingPrs = await getExistingPrs({ cwd, branchPrefix: config.branchPrefix })
  console.log(`  Found ${existingPrs.length} existing catalog-update PRs`)

  // 6b. Sync existing PRs (close stale, rebuild conflicting/outdated)
  console.log('\n6b. Syncing existing PRs...')
  const { closedCount: closedPrCount, rebuiltCount: rebuiltPrCount } = await syncExistingPrs({
    existingPrs,
    groups,
    config,
    cwd,
    packageJsonPath,
    releaseNotes
  })

  // 7. Create PRs
  const existingBranches = new Set(existingPrs.map((pr) => pr.headRefName))

  const skippedGroups = [...groups.keys()].filter((name) => existingBranches.has(`${config.branchPrefix}/${name}`))
  const adjustedExistingCount = existingPrs.length - closedPrCount
  const availableSlots = config.maxOpenPrs - adjustedExistingCount
  const eligibleGroups = groups.size - skippedGroups.length
  const prsToCreate = Math.min(eligibleGroups, availableSlots)

  console.log('\n7. Creating PRs...')
  console.log(`  PR limit: ${config.maxOpenPrs}, existing: ${adjustedExistingCount}, available slots: ${availableSlots}`)
  console.log(
    `  Groups with updates: ${groups.size}, already have PRs: ${skippedGroups.length}, eligible: ${eligibleGroups}`
  )
  console.log(`  PRs to create: ${prsToCreate}`)

  let created = 0
  let openPrCount = adjustedExistingCount

  for (const [groupName, updates] of groups) {
    if (openPrCount >= config.maxOpenPrs) {
      console.log(`\n  Reached PR limit (${config.maxOpenPrs}). Stopping.`)
      break
    }

    const branch = `${config.branchPrefix}/${groupName}`
    if (existingBranches.has(branch)) {
      console.log(`\n  Skipping "${groupName}" — PR already exists`)
      continue
    }

    const success = await createGroupPr({ groupName, updates, config, cwd, packageJsonPath, releaseNotes })
    if (success) {
      created++
      openPrCount++
    }
  }

  const failed = prsToCreate - created
  console.log(`\nDone! Created ${created}/${prsToCreate} PRs, rebuilt ${rebuiltPrCount} existing PRs.`)

  if (failed > 0) {
    console.error(`\n${failed} PR(s) failed to create.`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
