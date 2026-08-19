import { unlinkSync } from 'node:fs'
import type {
	BranchUpdate,
	Config,
	DirectoryContext,
	ExistingPr,
	UpdateCandidate,
	VersionReleaseNote
} from './types'
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

	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text()
	])
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

function getInstallCommand({
	packageManager
}: {
	packageManager: Config['packageManager']
}): string[] {
	switch (packageManager) {
		case 'bun':
			return ['bun', 'install']
		case 'npm':
			return ['npm', 'install']
		case 'pnpm':
			return ['pnpm', 'install']
		case 'yarn':
			return ['yarn', 'install']
	}
}

function getLockfileName({
	packageManager
}: {
	packageManager: Config['packageManager']
}): string {
	switch (packageManager) {
		case 'bun':
			return 'bun.lock'
		case 'npm':
			return 'package-lock.json'
		case 'pnpm':
			return 'pnpm-lock.yaml'
		case 'yarn':
			return 'yarn.lock'
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
	const sorted = [...updates].toSorted((a, b) => a.name.localeCompare(b.name))

	const lines = [
		'## Dependency Updates',
		'',
		'| Package | From | To | Type |',
		'| --- | --- | --- | --- |',
		...sorted.map(
			(u) =>
				`| \`${u.name}\` | ${u.currentVersion} | ${u.latestVersion} | ${u.changeType} |`
		)
	]

	lines.push(...formatReleaseNotes({ updates, releaseNotes }))
	lines.push('---', PR_FOOTER)

	return lines.join('\n')
}

export function buildCatalogValue({
	update
}: {
	update: UpdateCandidate
}): string {
	if (update.isAlias) {
		return `npm:${update.aliasName}@${update.rangePrefix}${update.latestVersion}`
	}
	return `${update.rangePrefix}${update.latestVersion}`
}

// ---------------------------------------------------------------------------
// Catalog BranchUpdate builder
// ---------------------------------------------------------------------------

export function buildCatalogBranchUpdate({
	groupName,
	updates,
	config,
	titleSuffix = '',
	branchPrefix,
	releaseNotes
}: {
	groupName: string
	updates: UpdateCandidate[]
	config: Config
	titleSuffix?: string
	branchPrefix?: string
	releaseNotes: Map<string, VersionReleaseNote[]>
}): BranchUpdate {
	const prefix = branchPrefix ?? config.branchPrefix
	const branch = `${prefix}/${groupName}`
	const first = updates[0]
	const title =
		first && updates.length === 1
			? `chore(deps): bump ${first.name} from ${first.currentVersion} to ${first.latestVersion}${titleSuffix}`
			: `chore(deps): bump ${groupName} dependencies${titleSuffix}`
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
			'gh',
			'pr',
			'list',
			'--state',
			'open',
			'--search',
			`head:${branchPrefix}`,
			'--json',
			'headRefName,number,mergeable,title',
			'--limit',
			'100'
		],
		cwd
	})

	try {
		const prs = JSON.parse(stdout || '[]') as ExistingPr[]
		return prs.filter(
			(pr) =>
				pr.headRefName.startsWith(`${branchPrefix}/`) ||
				pr.headRefName.startsWith(
					`${getOverrideBranchPrefix({ branchPrefix })}/`
				)
		)
	} catch {
		return []
	}
}

export async function hasNonBotCommits({
	pr,
	cwd
}: {
	pr: ExistingPr
	cwd: string
}): Promise<boolean> {
	const { stdout, exitCode } = await exec({
		command: ['gh', 'pr', 'view', String(pr.number), '--json', 'commits'],
		cwd
	})

	if (exitCode !== 0) return true

	try {
		const data = JSON.parse(stdout) as {
			commits: Array<{ authors: Array<{ login: string }> }>
		}
		return data.commits.some((commit) =>
			commit.authors.some((author) => author.login !== 'github-actions[bot]')
		)
	} catch {
		return true
	}
}

export async function resolveMergeableState({
	pr,
	cwd
}: {
	pr: ExistingPr
	cwd: string
}): Promise<ExistingPr['mergeable']> {
	if (pr.mergeable !== 'UNKNOWN') return pr.mergeable

	console.log(
		`  PR #${pr.number} has UNKNOWN mergeable state, retrying in 5s...`
	)
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
		command: [
			'git',
			'rev-list',
			'--count',
			`origin/${branch}..origin/${defaultBranch}`
		],
		cwd
	})

	if (exitCode !== 0) return true
	return Number(stdout) > 0
}

export async function readBranchPackageJson({
	branch,
	cwd,
	packageJsonRelPath
}: {
	branch: string
	cwd: string
	packageJsonRelPath: string
}): Promise<Record<string, unknown> | null> {
	const { stdout, exitCode } = await exec({
		command: ['git', 'show', `origin/${branch}:${packageJsonRelPath}`],
		cwd
	})

	if (exitCode !== 0) return null

	try {
		return JSON.parse(stdout) as Record<string, unknown>
	} catch {
		return null
	}
}

async function returnToDefault({
	defaultBranch,
	cwd
}: {
	defaultBranch: string
	cwd: string
}): Promise<void> {
	await exec({ command: ['git', 'checkout', '--', '.'], cwd })
	const { exitCode } = await exec({
		command: ['git', 'checkout', defaultBranch],
		cwd
	})
	if (exitCode !== 0) {
		throw new Error(
			`Fatal: failed to return to ${defaultBranch} branch. Aborting remaining groups.`
		)
	}
}

// ---------------------------------------------------------------------------
// Generic branch update + PR creation
// ---------------------------------------------------------------------------

export async function updateBranch({
	branchUpdate,
	config,
	dir
}: {
	branchUpdate: BranchUpdate
	config: Config
	dir: DirectoryContext
}): Promise<{ success: boolean }> {
	const { branch, title, applyChanges, deleteLockfile } = branchUpdate
	const { cwd, workDir, packageJsonPath, packageJsonRelPath } = dir

	const checkoutResult = await exec({
		command: [
			'git',
			'checkout',
			'-B',
			branch,
			`origin/${config.defaultBranch}`
		],
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

	// Bun's @range override syntax is ignored for already-locked packages.
	// Deleting the lockfile forces a full re-resolution so overrides apply.
	if (deleteLockfile) {
		const lockfileName = getLockfileName({
			packageManager: config.packageManager
		})
		const lockfilePath = `${workDir}/${lockfileName}`
		const exists = await Bun.file(lockfilePath).exists()
		if (exists) {
			unlinkSync(lockfilePath)
			console.log(
				`  Deleted ${lockfileName} to force re-resolution of overrides`
			)
		}
	}

	console.log('  Running install...')
	const installResult = await exec({
		command: getInstallCommand({ packageManager: config.packageManager }),
		cwd: workDir
	})
	if (installResult.exitCode !== 0) {
		console.error(`  Failed to run install for branch "${branch}"`)
		await returnToDefault({ defaultBranch: config.defaultBranch, cwd })
		return { success: false }
	}

	const { stdout: diffOutput } = await exec({
		command: ['git', 'diff', '--name-only'],
		cwd
	})
	const changedFiles = diffOutput.split('\n').filter(Boolean)

	const lockfileBasenames = new Set([
		'package.json',
		'bun.lock',
		'package-lock.json',
		'pnpm-lock.yaml',
		'yarn.lock'
	])
	const unexpectedFiles = changedFiles.filter(
		(f) => !lockfileBasenames.has(f.split('/').pop() || f)
	)
	if (unexpectedFiles.length > 0) {
		console.warn(
			`  Warning: install modified unexpected files: ${unexpectedFiles.join(', ')}`
		)
	}

	await exec({
		command: ['git', 'add', packageJsonRelPath, ...changedFiles],
		cwd
	})

	// --no-verify: skip pre-commit hooks since this is an automated action
	const commitResult = await exec({
		command: ['git', 'commit', '--no-verify', '-m', title],
		cwd
	})
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

// ---------------------------------------------------------------------------
// Auto-merge
// ---------------------------------------------------------------------------

/**
 * Turns on GitHub auto-merge for a PR this run owns.
 *
 * Enabling it here rather than from a `pull_request` workflow in the consumer
 * repo matters: this process created the PR, so it merges on that basis. A
 * workflow can only recognise the PR by branch name, and any name is available
 * to anyone with push access.
 *
 * Auto-merge waits for the required status checks on the base branch. Without
 * such checks there is nothing to wait for, so GitHub refuses to arm it. A
 * failure here is never fatal, because the PR is already open.
 */
export async function enableAutoMerge({
	prRef,
	config,
	dir
}: {
	prRef: string
	config: Config
	dir: DirectoryContext
}): Promise<boolean> {
	const result = await exec({
		command: [
			'gh',
			'pr',
			'merge',
			prRef,
			'--auto',
			`--${config.autoMerge.mergeMethod}`
		],
		cwd: dir.cwd
	})

	if (result.exitCode === 0) {
		console.log(`  Auto-merge enabled (${config.autoMerge.mergeMethod})`)
		return true
	}

	console.warn(`  Warning: could not enable auto-merge for ${prRef}`)

	if (result.stderr.includes('Auto-merge is not allowed')) {
		console.warn(
			'  Enable "Allow auto-merge" in repository Settings > General > Pull Requests.'
		)
	} else if (result.stderr.includes('clean status')) {
		console.warn(
			`  Nothing blocks this PR, so auto-merge has nothing to wait for. Add required status checks to "${config.defaultBranch}", otherwise autoMerge lands updates unchecked.`
		)
	} else if (
		result.stderr.includes('merging is not allowed') ||
		result.stderr.includes('Merge commits are not allowed')
	) {
		console.warn(
			`  The "${config.autoMerge.mergeMethod}" merge method is disabled for this repository. Allow it, or pick another autoMerge.mergeMethod.`
		)
	}

	return false
}

export async function createPr({
	branchUpdate,
	config,
	dir
}: {
	branchUpdate: BranchUpdate
	config: Config
	dir: DirectoryContext
}): Promise<boolean> {
	console.log(`\n  Creating PR for branch "${branchUpdate.branch}"`)

	const result = await updateBranch({ branchUpdate, config, dir })
	if (!result.success) return false

	const prResult = await exec({
		command: [
			'gh',
			'pr',
			'create',
			'--base',
			config.defaultBranch,
			'--head',
			branchUpdate.branch,
			'--title',
			branchUpdate.title,
			'--body',
			branchUpdate.body
		],
		cwd: dir.cwd
	})

	if (prResult.exitCode === 0) {
		console.log(`  PR created: ${prResult.stdout}`)
		if (config.autoMerge.enabled) {
			// gh prints the new PR's URL, which beats a second branch lookup.
			const prRef = prResult.stdout.startsWith('https://')
				? prResult.stdout
				: branchUpdate.branch
			await enableAutoMerge({ prRef, config, dir })
		}
	} else {
		console.error(`  Failed to create PR for branch "${branchUpdate.branch}"`)
		if (
			prResult.stderr?.includes(
				'not permitted to create or approve pull requests'
			)
		) {
			console.error(
				'  Enable "Allow GitHub Actions to create and approve pull requests" in repository Settings > Actions > General > Workflow permissions.'
			)
			console.error(
				'  If the checkbox is disabled, an organization admin must first enable it in Organization Settings > Actions > General > Workflow permissions.'
			)
		}
	}

	return prResult.exitCode === 0
}

export async function syncExistingPrs({
	existingPrs,
	resolveBranchUpdate,
	isBranchContentOutdated,
	config,
	dir
}: {
	existingPrs: ExistingPr[]
	resolveBranchUpdate: (branchName: string) => BranchUpdate | null
	isBranchContentOutdated: (
		branchPackageJson: Record<string, unknown>,
		branchName: string
	) => boolean
	config: Config
	dir: DirectoryContext
}): Promise<{ closedCount: number; rebuiltCount: number }> {
	if (existingPrs.length === 0) {
		console.log('  No existing PRs to sync')
		return { closedCount: 0, rebuiltCount: 0 }
	}

	console.log(`  Syncing ${existingPrs.length} existing PR(s)`)

	const nonBotResults = new Map<number, boolean>()
	await Promise.all(
		existingPrs.map(async (pr) => {
			nonBotResults.set(pr.number, await hasNonBotCommits({ pr, cwd: dir.cwd }))
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
					'gh',
					'pr',
					'close',
					String(pr.number),
					'--comment',
					'Closing: all packages in this group are already up to date.'
				],
				cwd: dir.cwd
			})
			if (closeResult.exitCode === 0) {
				closedCount++
			}
			continue
		}

		const mergeable = await resolveMergeableState({ pr, cwd: dir.cwd })
		const isConflicting = mergeable === 'CONFLICTING'
		const behindDefault =
			!isConflicting &&
			(await isBranchBehindDefault({
				branch: pr.headRefName,
				defaultBranch: config.defaultBranch,
				cwd: dir.cwd
			}))

		let hasContentChanges = false
		if (!isConflicting && !behindDefault) {
			const branchPkg = await readBranchPackageJson({
				branch: pr.headRefName,
				cwd: dir.cwd,
				packageJsonRelPath: dir.packageJsonRelPath
			})
			hasContentChanges =
				!branchPkg || isBranchContentOutdated(branchPkg, pr.headRefName)
		}

		if (!isConflicting && !behindDefault && !hasContentChanges) {
			console.log(`  PR #${pr.number} (${pr.headRefName}) is up to date`)
			// Re-arm rather than skip: this picks up PRs opened before autoMerge
			// was turned on, and retries any earlier attempt that failed.
			if (config.autoMerge.enabled) {
				await enableAutoMerge({ prRef: String(pr.number), config, dir })
			}
			continue
		}

		let reason = 'outdated content'
		if (isConflicting) reason = 'conflicting'
		else if (behindDefault) reason = `behind ${config.defaultBranch}`
		console.log(
			`\n  Rebuilding PR #${pr.number} (${pr.headRefName}) — ${reason}`
		)

		try {
			const result = await updateBranch({ branchUpdate, config, dir })
			if (!result.success) {
				console.error(
					`  Failed to rebuild PR #${pr.number} (${pr.headRefName})`
				)
				continue
			}

			const editResult = await exec({
				command: [
					'gh',
					'pr',
					'edit',
					String(pr.number),
					'--title',
					branchUpdate.title,
					'--body',
					branchUpdate.body
				],
				cwd: dir.cwd
			})

			if (editResult.exitCode !== 0) {
				console.warn(
					`  Warning: Failed to update title/body for PR #${pr.number}, but branch was rebuilt`
				)
			}

			// The rebuild force-pushes the branch, so arm the PR again.
			if (config.autoMerge.enabled) {
				await enableAutoMerge({ prRef: String(pr.number), config, dir })
			}

			console.log(`  Successfully rebuilt PR #${pr.number} (${pr.headRefName})`)
			rebuiltCount++
		} catch (error: unknown) {
			console.error(
				`  Error rebuilding PR #${pr.number} (${pr.headRefName}): ${String(error)}`
			)
		}
	}

	return { closedCount, rebuiltCount }
}
