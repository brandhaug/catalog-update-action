#!/usr/bin/env bun
import { loadConfig } from './config'
import { parseCatalog } from './catalog'
import { queryNpmRegistry, queryPackageMetadata, queryReleaseNotes } from './registry'
import { shouldIgnore, assignToGroups } from './groups'
import { exec, getExistingPrs, syncExistingPrs, createPr, buildCatalogBranchUpdate, buildCatalogValue } from './git'
import { runAudit, computeOverrides, buildOverrideBranchUpdate, isOverrideBranchOutdated } from './audit'
import { classifySemverChange, Semaphore, getOverrideBranchPrefix } from './utils'
import type { BranchUpdate, OverrideEntry, UpdateCandidate, VersionReleaseNote } from './types'

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const HELP_TEXT = `
catalog-update — Automated dependency updates for Bun catalog: protocol

Usage:
  catalog-update [options]
  bunx catalog-update-action [options]

Options:
  -h, --help            Show this help message and exit
  -v, --version         Show version and exit
  -d, --dry-run         Show what would be updated without creating PRs
  -c, --config <path>   Path to config file (default: .catalog-updaterc.json)

Examples:
  # Preview updates without creating PRs
  catalog-update --dry-run

  # Use a custom config file
  catalog-update --config custom-config.json

  # GitHub Action usage (in .github/workflows/*.yml)
  - uses: brandhaug/catalog-update-action@v1
`.trim()

function parseArgs(): { dryRun: boolean; configPath: string } {
  const args = process.argv.slice(2)
  let configPath = '.catalog-updaterc.json'
  let dryRun = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--help' || arg === '-h') {
      console.log(HELP_TEXT)
      process.exit(0)
    } else if (arg === '--version' || arg === '-v') {
      const pkg = require('../package.json')
      console.log(pkg.version)
      process.exit(0)
    } else if (arg === '--dry-run' || arg === '-d') {
      dryRun = true
    } else if ((arg === '--config' || arg === '-c') && args[i + 1] !== undefined) {
      configPath = args[i + 1] as string
      i++
    } else if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}`)
      console.error('Run with --help for usage information.')
      process.exit(1)
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

  // 0. Fetch latest remote refs (needed for branch comparisons and checkouts)
  console.log('0. Fetching latest remote refs...')
  const fetchResult = await exec({ command: ['git', 'fetch', 'origin'], cwd })
  if (fetchResult.exitCode !== 0) {
    console.error('Failed to fetch from origin')
    process.exit(1)
  }

  // 1. Load config
  console.log('1. Loading config...')
  const config = await loadConfig({ configPath: `${cwd}/${configPath}` })
  console.log(`  Branch prefix: ${config.branchPrefix}`)
  console.log(`  Default branch: ${config.defaultBranch}`)
  console.log(`  Package manager: ${config.packageManager}`)
  console.log(`  Groups: ${config.groups.length}`)
  console.log(`  Ignore rules: ${config.ignore.length}`)
  console.log(`  Audit: ${config.audit.enabled ? `enabled (minimum severity: ${config.audit.minimumSeverity})` : 'disabled'}`)

  // 2. Parse catalog
  console.log('\n2. Parsing catalog...')
  const packageJson = await Bun.file(packageJsonPath).json()
  const catalog = packageJson.catalog as Record<string, string> | undefined

  if (!catalog) {
    console.error('No catalog found in package.json')
    process.exit(1)
  }

  const entries = parseCatalog({ catalog })
  console.log(`  Found ${entries.length} catalog entries`)

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

  // 5. Catalog pipeline: metadata, release notes, grouping
  let groups = new Map<string, UpdateCandidate[]>()
  let releaseNotes = new Map<string, VersionReleaseNote[]>()

  if (candidates.length > 0) {
    // 4b. Fetch package metadata and release notes
    console.log('\n4b. Fetching package metadata (repo URLs + published versions)...')
    const packageMetadata = await queryPackageMetadata({ candidates, semaphore })
    console.log(`  Found metadata for ${packageMetadata.size}/${candidates.length} packages`)

    console.log('\n4c. Fetching release notes (multi-version)...')
    releaseNotes = await queryReleaseNotes({ candidates, packageMetadata, semaphore })
    console.log(`  Found release notes for ${releaseNotes.size}/${candidates.length} packages`)

    // 5. Group updates
    console.log('\n5. Grouping updates...')
    groups = assignToGroups({ candidates, groups: config.groups })

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
  }

  // 5b. Override pipeline (if enabled)
  let overrideBranchUpdate: BranchUpdate | null = null
  let overrideEntries: OverrideEntry[] = []
  const overrideBranchPrefix = getOverrideBranchPrefix({ branchPrefix: config.branchPrefix })

  if (config.audit.enabled) {
    console.log('\n5b. Running bun audit for transitive vulnerability overrides...')
    const auditResult = await runAudit({ cwd })

    if (auditResult) {
      const catalogNames = new Set(entries.map((e) => e.name))
      const existingOverrides = (packageJson.overrides as Record<string, string> | undefined) ?? {}

      overrideEntries = computeOverrides({
        auditResult,
        catalogNames,
        minimumSeverity: config.audit.minimumSeverity,
        existingOverrides
      })

      if (overrideEntries.length > 0) {
        console.log(`  Found ${overrideEntries.length} transitive vulnerability override(s):`)
        for (const o of overrideEntries) {
          const severities = [...new Set(o.advisories.map((a) => a.severity))].join(', ')
          console.log(`    ${o.packageName} → ${o.fixedVersion} (${severities})`)
        }

        overrideBranchUpdate = buildOverrideBranchUpdate({
          overrides: overrideEntries,
          branchPrefix: config.branchPrefix
        })
      } else {
        console.log('  No transitive vulnerability overrides needed')
      }
    } else {
      console.log('  bun audit unavailable or failed, skipping override pipeline')
    }
  }

  if (candidates.length === 0 && !overrideBranchUpdate) {
    console.log('\nNo updates available. Done!')
    return
  }

  if (dryRun) {
    const parts: string[] = []
    if (groups.size > 0) parts.push(`${groups.size} catalog PRs`)
    if (overrideBranchUpdate) parts.push('1 override PR')
    console.log(`\n[DRY RUN] Would create ${parts.join(' and ')} for the above groups. Exiting.`)
    return
  }

  // 6. Check existing PRs
  console.log('\n6. Checking existing PRs...')
  const existingPrs = await getExistingPrs({ cwd, branchPrefix: config.branchPrefix })
  console.log(`  Found ${existingPrs.length} existing catalog-update PRs`)

  // Separate catalog PRs and override PRs.
  // Works because override branches use `${branchPrefix}-override/` (note the `-override` suffix).
  const catalogPrs = existingPrs.filter((pr) => pr.headRefName.startsWith(`${config.branchPrefix}/`))
  const overridePrs = existingPrs.filter((pr) => pr.headRefName.startsWith(`${overrideBranchPrefix}/`))

  // 6b. Sync existing catalog PRs
  console.log('\n6b. Syncing existing catalog PRs...')
  const catalogSyncResult = await syncExistingPrs({
    existingPrs: catalogPrs,
    resolveBranchUpdate: (branchName: string) => {
      const groupName = branchName.slice(`${config.branchPrefix}/`.length)
      const updates = groups.get(groupName)
      if (!updates || updates.length === 0) return null
      return buildCatalogBranchUpdate({ groupName, updates, config, releaseNotes })
    },
    isBranchContentOutdated: (branchPkg: Record<string, unknown>, branchName: string) => {
      const groupName = branchName.slice(`${config.branchPrefix}/`.length)
      const updates = groups.get(groupName)
      if (!updates) return true
      const branchCatalog = branchPkg.catalog as Record<string, string> | undefined
      if (!branchCatalog) return true
      for (const update of updates) {
        const expected = buildCatalogValue({ update })
        if (branchCatalog[update.name] !== expected) return true
      }
      return false
    },
    config,
    cwd,
    packageJsonPath
  })

  // 6c. Sync existing override PRs
  let overrideSyncResult = { closedCount: 0, rebuiltCount: 0 }
  if (overridePrs.length > 0) {
    console.log('\n6c. Syncing existing override PRs...')
    overrideSyncResult = await syncExistingPrs({
      existingPrs: overridePrs,
      resolveBranchUpdate: (_branchName: string) => overrideBranchUpdate,
      isBranchContentOutdated: (branchPkg: Record<string, unknown>) => {
        return isOverrideBranchOutdated({ branchPackageJson: branchPkg, expectedOverrides: overrideEntries })
      },
      config,
      cwd,
      packageJsonPath
    })
  }

  const totalClosedCount = catalogSyncResult.closedCount + overrideSyncResult.closedCount
  const totalRebuiltCount = catalogSyncResult.rebuiltCount + overrideSyncResult.rebuiltCount

  // 7. Create PRs
  const existingBranches = new Set(existingPrs.map((pr) => pr.headRefName))

  // Rebuilt PRs still occupy slots (they remain open), only closed PRs free slots
  const adjustedExistingCount = existingPrs.length - totalClosedCount
  let availableSlots = config.maxOpenPrs - adjustedExistingCount

  console.log('\n7. Creating PRs...')
  console.log(`  PR limit: ${config.maxOpenPrs}, existing: ${adjustedExistingCount}, available slots: ${availableSlots}`)

  let created = 0
  let openPrCount = adjustedExistingCount

  // Override PR first (security priority)
  if (overrideBranchUpdate && availableSlots > 0 && !existingBranches.has(overrideBranchUpdate.branch)) {
    const success = await createPr({ branchUpdate: overrideBranchUpdate, config, cwd, packageJsonPath })
    if (success) {
      created++
      openPrCount++
      availableSlots--
    }
  }

  // Catalog PRs
  const skippedGroups = [...groups.keys()].filter((name) => existingBranches.has(`${config.branchPrefix}/${name}`))
  const eligibleGroups = groups.size - skippedGroups.length
  const prsToCreate = Math.min(eligibleGroups, availableSlots)

  console.log(`  Groups with updates: ${groups.size}, already have PRs: ${skippedGroups.length}, eligible: ${eligibleGroups}`)
  console.log(`  Catalog PRs to create: ${prsToCreate}`)

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

    const branchUpdate = buildCatalogBranchUpdate({ groupName, updates, config, releaseNotes })
    const success = await createPr({ branchUpdate, config, cwd, packageJsonPath })
    if (success) {
      created++
      openPrCount++
    }
  }

  const totalExpected = prsToCreate + (overrideBranchUpdate && !existingBranches.has(overrideBranchUpdate.branch) ? 1 : 0)
  const failed = totalExpected - created
  console.log(`\nDone! Created ${created}/${totalExpected} PRs, rebuilt ${totalRebuiltCount} existing PRs.`)

  if (failed > 0) {
    console.error(`\n${failed} PR(s) failed to create.`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
