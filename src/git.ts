import { Effect, FileSystem, Option, Schema } from 'effect'
import { Commands } from './commands'
import { formatReleaseNotes } from './release-notes'
import { mergeableSchema, parseJsonDocument } from './schemas'
import { getOverrideBranchPrefix, PR_FOOTER } from './utils'
import { expectedInstallBasenames, getProvider } from './providers'
import {
	BranchApplyError,
	type BranchUpdate,
	type CatalogLocation,
	type Config,
	type DirectoryContext,
	type ExistingPr,
	type PrSyncPlan,
	type UpdateCandidate,
	type VersionReleaseNote
} from './types'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Fatal git workflow failure: the working tree could not be restored. */
// Module-local on purpose: main.ts recovers via Effect.catchTag('GitError'),
// so the class has no importer — its tag and shape are the contract.
// Schema.TaggedError declarations are class declarations, not throw sites;
// unicorn/throw-new-error misreads the TaggedError() constructor call as an
// un-newed throw.
// oxlint-disable-next-line unicorn/throw-new-error
class GitError extends Schema.TaggedError<GitError>()('GitError', {
	operation: Schema.String,
	cause: Schema.Defect()
}) {}

// ---------------------------------------------------------------------------
// Catalog PR body
// ---------------------------------------------------------------------------

export function buildCatalogPrBody({
	updates,
	releaseNotes
}: {
	updates: Array<UpdateCandidate>
	releaseNotes: Map<string, Array<VersionReleaseNote>>
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

	lines.push(...formatReleaseNotes({ updates, releaseNotes }), '---', PR_FOOTER)

	return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Catalog BranchUpdate builder
// ---------------------------------------------------------------------------

export function buildCatalogBranchUpdate({
	groupName,
	updates,
	config,
	location,
	workDir,
	titleSuffix = '',
	branchPrefix,
	releaseNotes
}: {
	groupName: string
	updates: Array<UpdateCandidate>
	config: Config
	location: CatalogLocation
	workDir: string
	titleSuffix?: string
	branchPrefix?: string
	releaseNotes: Map<string, Array<VersionReleaseNote>>
}): BranchUpdate {
	const prefix = branchPrefix ?? config.branchPrefix
	const branch = `${prefix}/${groupName}`
	const provider = getProvider(location.providerId)
	const definitionPath = `${workDir}/${location.definitionRelPath}`
	const affectedFiles = [location.definitionRelPath]
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
		affectedFiles,
		expectedBasenames: expectedInstallBasenames({ provider, affectedFiles }),
		installCommand: provider.installCommand,
		apply: Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const content = yield* fs.readFileString(definitionPath).pipe(
				Effect.mapError(
					(cause) =>
						new BranchApplyError({
							operation: 'Git.buildCatalogBranchUpdate.read',
							cause
						})
				)
			)
			const updated = yield* Effect.try({
				try: () =>
					provider.applyUpdates({
						content,
						catalogName: location.definition.catalogName,
						updates
					}),
				catch: (cause) =>
					new BranchApplyError({
						operation: 'Git.buildCatalogBranchUpdate.applyUpdates',
						cause
					})
			})
			yield* fs.writeFileString(definitionPath, updated).pipe(
				Effect.mapError(
					(cause) =>
						new BranchApplyError({
							operation: 'Git.buildCatalogBranchUpdate.write',
							cause
						})
				)
			)
		})
	}
}

// ---------------------------------------------------------------------------
// Existing PRs
// ---------------------------------------------------------------------------

/** Validate a `gh pr list --json` item before trusting its fields. */
const existingPrSchema = Schema.Struct({
	headRefName: Schema.String,
	number: Schema.Number,
	mergeable: mergeableSchema,
	title: Schema.String
})

/** Shape of `gh api repos/{owner}/{repo}/pulls/N/commits` output. */
const prApiCommitsSchema = Schema.Array(
	Schema.Struct({
		author: Schema.optionalKey(
			Schema.NullOr(Schema.Struct({ login: Schema.NullOr(Schema.String) }))
		),
		parents: Schema.optionalKey(Schema.Array(Schema.Unknown))
	})
)

/**
 * Whether the PR carries human-authored content commits. Merge commits
 * (e.g. GitHub's "Update branch") never contain content changes, so they are
 * ignored regardless of author.
 */
export function hasHumanContentCommits({ raw }: { raw: unknown }): boolean {
	const commits = Schema.decodeUnknownOption(prApiCommitsSchema)(raw)
	// Any malformed shape or non-bot author means the PR may carry human
	// work, so it is treated as "has human content commits" and left alone.
	if (Option.isNone(commits)) {
		return true
	}
	return commits.value.some(
		(commit) =>
			(commit.parents ?? []).length < 2 &&
			commit.author?.login !== 'github-actions[bot]'
	)
}

const mergeableStateSchema = Schema.Struct({ mergeable: mergeableSchema })

export const getExistingPrs = Effect.fn('Git.getExistingPrs')(function* ({
	cwd,
	branchPrefix
}: {
	cwd: string
	branchPrefix: string
}) {
	const commands = yield* Commands
	const result = yield* commands.exec(
		[
			'gh',
			'pr',
			'list',
			'--state',
			'open',
			'--search',
			`head:${branchPrefix}`,
			'--json',
			'headRefName,number,mergeable,title'
		],
		{ cwd }
	)

	// This list is the run's idempotency anchor: believing "no existing PRs"
	// on a malformed payload would make the run create duplicates, so a bad
	// payload is warned about loudly rather than swallowed.
	const parsed = parseJsonDocument(result.stdout || '[]')
	if (Option.isNone(parsed)) {
		yield* Effect.logWarning(
			`  Warning: existing-PR list for prefix "${branchPrefix}" was not valid JSON; treating as none`
		)
		return []
	}

	const decoded = Schema.decodeUnknownOption(Schema.Array(existingPrSchema))(
		parsed.value
	)
	if (Option.isNone(decoded)) {
		yield* Effect.logWarning(
			`  Warning: existing-PR list for prefix "${branchPrefix}" had an unexpected shape; treating as none`
		)
		return []
	}
	return decoded.value.filter(
		(pr) =>
			pr.headRefName.startsWith(`${branchPrefix}/`) ||
			pr.headRefName.startsWith(`${getOverrideBranchPrefix({ branchPrefix })}/`)
	)
})

// ---------------------------------------------------------------------------
// Branch operations
// ---------------------------------------------------------------------------

const execLogged = Effect.fn('Git.execLogged')(function* (
	command: Array<string>,
	cwd: string
) {
	const commands = yield* Commands
	const result = yield* commands.exec(command, { cwd })
	if (result.exitCode !== 0) {
		yield* Effect.logError(`  Command failed: ${command.join(' ')}`)
		if (result.stderr) {
			yield* Effect.logError(`  stderr: ${result.stderr}`)
		}
	}
	return result
})

const hasNonBotCommits = Effect.fn('Git.hasNonBotCommits')(function* ({
	pr,
	cwd
}: {
	pr: ExistingPr
	cwd: string
}) {
	const commands = yield* Commands
	const result = yield* commands.exec(
		['gh', 'api', `repos/{owner}/{repo}/pulls/${pr.number}/commits`],
		{ cwd }
	)
	if (result.exitCode !== 0) {
		return true
	}

	const parsed = parseJsonDocument(result.stdout)
	if (Option.isNone(parsed)) {
		return true
	}
	return hasHumanContentCommits({ raw: parsed.value })
})

const resolveMergeableState = Effect.fn('Git.resolveMergeableState')(
	function* ({ pr, cwd }: { pr: ExistingPr; cwd: string }) {
		if (pr.mergeable !== 'UNKNOWN') {
			return pr.mergeable
		}

		yield* Effect.logInfo(
			`  PR #${pr.number} has UNKNOWN mergeable state, retrying in 5s...`
		)
		yield* Effect.sleep('5 seconds')

		const result = yield* execLogged(
			['gh', 'pr', 'view', String(pr.number), '--json', 'mergeable'],
			cwd
		)
		if (result.exitCode !== 0) {
			return 'UNKNOWN'
		}

		const option = parseJsonDocument(result.stdout)
		if (Option.isNone(option)) {
			return 'UNKNOWN'
		}
		const decoded = Schema.decodeUnknownOption(mergeableStateSchema)(
			option.value
		)
		if (Option.isNone(decoded)) {
			return 'UNKNOWN'
		}
		return decoded.value.mergeable
	}
)

const isBranchBehindDefault = Effect.fn('Git.isBranchBehindDefault')(
	function* ({
		branch,
		defaultBranch,
		cwd
	}: {
		branch: string
		defaultBranch: string
		cwd: string
	}) {
		const result = yield* execLogged(
			[
				'git',
				'rev-list',
				'--count',
				`origin/${branch}..origin/${defaultBranch}`
			],
			cwd
		)

		if (result.exitCode !== 0) {
			return true
		}
		return Number(result.stdout) > 0
	}
)

/** Read a single file from a remote branch via `git show`; null when absent. */
const readBranchFile = Effect.fn('Git.readBranchFile')(function* ({
	branch,
	relPath,
	cwd
}: {
	branch: string
	relPath: string
	cwd: string
}) {
	const commands = yield* Commands
	const result = yield* commands.exec(
		['git', 'show', `origin/${branch}:${relPath}`],
		{
			cwd
		}
	)

	if (result.exitCode !== 0) {
		return null
	}
	return result.stdout
})

/**
 * Return the working tree to the default branch. Failure is fatal to the
 * remaining groups, so it surfaces as a typed GitError.
 */
const returnToDefault = Effect.fn('Git.returnToDefault')(function* ({
	defaultBranch,
	cwd
}: {
	defaultBranch: string
	cwd: string
}) {
	yield* execLogged(['git', 'checkout', '--', '.'], cwd)
	const commands = yield* Commands
	const result = yield* commands.exec(['git', 'checkout', defaultBranch], {
		cwd
	})
	if (result.exitCode !== 0) {
		return yield* new GitError({
			operation: 'Git.returnToDefault',
			cause: `failed to check out ${defaultBranch}: ${result.stderr}`
		})
	}
})

// ---------------------------------------------------------------------------
// Generic branch update + PR creation
// ---------------------------------------------------------------------------

/** Last few lines of a command's output, indented for the run log. */
const outputTail = (text: string): string =>
	text
		.trim()
		.split('\n')
		.slice(-8)
		.map((line) => `  ${line}`)
		.join('\n')

const updateBranch = Effect.fn('Git.updateBranch')(function* ({
	branchUpdate,
	config,
	dir
}: {
	branchUpdate: BranchUpdate
	config: Config
	dir: DirectoryContext
}) {
	const {
		branch,
		title,
		apply,
		affectedFiles,
		expectedBasenames,
		deleteLockfiles,
		installCommand
	} = branchUpdate
	const { cwd, workDir } = dir

	const commands = yield* Commands
	const fs = yield* FileSystem.FileSystem

	const checkoutResult = yield* commands.exec(
		['git', 'checkout', '-B', branch, `origin/${config.defaultBranch}`],
		{ cwd }
	)
	if (checkoutResult.exitCode !== 0) {
		return false
	}

	// Roll back to the default branch after any mid-pipeline failure so the
	// next group isn't processed from a half-built branch state.
	const fail = (message: string) =>
		Effect.gen(function* () {
			yield* Effect.logError(message)
			yield* returnToDefault({ defaultBranch: config.defaultBranch, cwd })
			return false
		})

	// Apply failure rolls back and reports a plain failure; only a fatal
	// returnToDefault failure (GitError) escapes this workflow.
	const applied = yield* Effect.result(apply)
	if (applied._tag === 'Failure') {
		return yield* fail(`  ${String(applied.failure)}`)
	}

	// Range-based override syntax is ignored for already-locked packages.
	// Deleting the lockfile forces a full re-resolution so overrides apply.
	for (const lockfileName of deleteLockfiles ?? []) {
		const lockfilePath = `${workDir}/${lockfileName}`
		const exists = yield* fs
			.exists(lockfilePath)
			.pipe(Effect.catch(() => Effect.succeed(false)))
		if (exists) {
			yield* fs.remove(lockfilePath).pipe(
				Effect.mapError(
					(cause) =>
						new GitError({
							operation: 'Git.updateBranch.removeLockfile',
							cause
						})
				)
			)
			yield* Effect.logInfo(
				`  Deleted ${lockfileName} to force re-resolution of overrides`
			)
		}
	}

	yield* Effect.logInfo('  Running install...')
	const installResult = yield* commands.exec(installCommand, { cwd: workDir })
	if (installResult.exitCode !== 0) {
		// pnpm writes its ERR_PNPM_* diagnostics to stdout, others to stderr;
		// surface the tail of both so the log explains the failure.
		const details = [
			outputTail(installResult.stdout),
			outputTail(installResult.stderr)
		]
			.filter(Boolean)
			.join('\n')
		if (details) {
			yield* Effect.logError(`  Install output:\n${details}`)
		}
		return yield* fail(`  Failed to run install for branch "${branch}"`)
	}

	const diffResult = yield* execLogged(['git', 'diff', '--name-only'], cwd)
	const changedFiles = diffResult.stdout.split('\n').filter(Boolean)

	const expected = new Set(expectedBasenames)
	const unexpectedFiles = changedFiles.filter(
		(f) => !expected.has(f.split('/').pop() || f)
	)
	if (unexpectedFiles.length > 0) {
		yield* Effect.logWarning(
			`  Warning: install modified unexpected files: ${unexpectedFiles.join(', ')}`
		)
	}

	yield* commands.exec(['git', 'add', ...affectedFiles, ...changedFiles], {
		cwd
	})

	// --no-verify: skip pre-commit hooks since this is an automated action
	const commitResult = yield* commands.exec(
		['git', 'commit', '--no-verify', '-m', title],
		{ cwd }
	)
	if (commitResult.exitCode !== 0) {
		return yield* fail(`  Failed to commit for branch "${branch}"`)
	}

	const pushResult = yield* commands.exec(
		['git', 'push', `--force-with-lease=${branch}`, 'origin', branch],
		{ cwd }
	)
	if (pushResult.exitCode !== 0) {
		return yield* fail(`  Failed to push branch "${branch}"`)
	}

	yield* returnToDefault({ defaultBranch: config.defaultBranch, cwd })
	return true
})

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
const enableAutoMerge = Effect.fn('Git.enableAutoMerge')(function* ({
	prRef,
	config,
	dir
}: {
	prRef: string
	config: Config
	dir: DirectoryContext
}) {
	const commands = yield* Commands
	const result = yield* commands.exec(
		['gh', 'pr', 'merge', prRef, '--auto', `--${config.autoMerge.mergeMethod}`],
		{ cwd: dir.cwd }
	)

	if (result.exitCode === 0) {
		yield* Effect.logInfo(
			`  Auto-merge enabled (${config.autoMerge.mergeMethod})`
		)
		return true
	}

	yield* Effect.logWarning(
		`  Warning: could not enable auto-merge for ${prRef}`
	)

	// GitHub spells this error both ways depending on the API surface, so
	// match the hyphenated and unhyphenated forms.
	const autoMergeDisallowed =
		result.stderr.includes('Auto-merge is not allowed') ||
		result.stderr.includes('Auto merge is not allowed')

	if (autoMergeDisallowed) {
		yield* Effect.logWarning(
			'  Enable "Allow auto-merge" in repository Settings > General > Pull Requests.'
		)
	} else if (result.stderr.includes('clean status')) {
		yield* Effect.logWarning(
			`  Nothing blocks this PR, so auto-merge has nothing to wait for. Add required status checks to "${config.defaultBranch}", otherwise autoMerge lands updates unchecked.`
		)
	} else if (
		result.stderr.includes('merging is not allowed') ||
		result.stderr.includes('Merge commits are not allowed')
	) {
		yield* Effect.logWarning(
			`  The "${config.autoMerge.mergeMethod}" merge method is disabled for this repository. Allow it, or pick another autoMerge.mergeMethod.`
		)
	} else {
		// No recognized cause: surface the raw error so the run log stays
		// actionable instead of ending on a bare warning.
		yield* Effect.logWarning(`  ${result.stderr.trim()}`)
	}

	return false
})

export const createPr = Effect.fn('Git.createPr')(function* ({
	branchUpdate,
	config,
	dir
}: {
	branchUpdate: BranchUpdate
	config: Config
	dir: DirectoryContext
}) {
	yield* Effect.logInfo(`\n  Creating PR for branch "${branchUpdate.branch}"`)

	const updated = yield* updateBranch({ branchUpdate, config, dir })
	if (!updated) {
		return false
	}

	const commands = yield* Commands
	const prResult = yield* commands.exec(
		[
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
		{ cwd: dir.cwd }
	)

	if (prResult.exitCode === 0) {
		yield* Effect.logInfo(`  PR created: ${prResult.stdout}`)
		if (config.autoMerge.enabled) {
			// gh prints the new PR's URL, which beats a second branch lookup.
			const prRef = prResult.stdout.startsWith('https://')
				? prResult.stdout
				: branchUpdate.branch
			yield* enableAutoMerge({ prRef, config, dir })
		}
	} else {
		yield* Effect.logError(
			`  Failed to create PR for branch "${branchUpdate.branch}"`
		)
		if (
			prResult.stderr.includes(
				'not permitted to create or approve pull requests'
			)
		) {
			yield* Effect.logError(
				'  Enable "Allow GitHub Actions to create and approve pull requests" in repository Settings > Actions > General > Workflow permissions.'
			)
			yield* Effect.logError(
				'  If the checkbox is disabled, an organization admin must first enable it in Organization Settings > Actions > General > Workflow permissions.'
			)
		}
	}

	return prResult.exitCode === 0
})

export const syncExistingPrs = Effect.fn('Git.syncExistingPrs')(function* ({
	existingPrs,
	resolveSyncPlan,
	config,
	dir
}: {
	existingPrs: Array<ExistingPr>
	resolveSyncPlan: (pr: ExistingPr) => PrSyncPlan | null
	config: Config
	dir: DirectoryContext
}) {
	if (existingPrs.length === 0) {
		yield* Effect.logInfo('  No existing PRs to sync')
		return { closedCount: 0, rebuiltCount: 0 }
	}

	yield* Effect.logInfo(`  Syncing ${existingPrs.length} existing PR(s)`)

	const commands = yield* Commands

	// Commit authorship checks are independent read-only queries, so they run
	// concurrently ahead of the sequential sync loop. Effect.forEach returns
	// one flag per PR, in order.
	const nonBotFlags = yield* Effect.forEach(
		existingPrs,
		(pr) => hasNonBotCommits({ pr, cwd: dir.cwd }),
		{ concurrency: 'unbounded' }
	)

	let closedCount = 0
	let rebuiltCount = 0

	// Each iteration mutates the shared working tree (git checkout, install,
	// commit, push) and can touch the same branches as the others, so PRs must
	// be processed one at a time rather than in parallel.
	for (const [index, pr] of existingPrs.entries()) {
		if (nonBotFlags[index] === true) {
			yield* Effect.logInfo(
				`  Skipping PR #${pr.number} — has human-authored content commits`
			)
			continue
		}

		const plan = resolveSyncPlan(pr)

		if (!plan) {
			yield* Effect.logInfo(
				`  Closing stale PR #${pr.number} — no longer needed`
			)
			const closeResult = yield* commands.exec(
				[
					'gh',
					'pr',
					'close',
					String(pr.number),
					'--comment',
					'Closing: all packages in this group are already up to date.'
				],
				{ cwd: dir.cwd }
			)
			if (closeResult.exitCode === 0) {
				closedCount++
			}
			continue
		}

		// Not destructured: isOutdated is a method on the plan object.
		const branchUpdate = plan.branchUpdate

		const mergeable = yield* resolveMergeableState({ pr, cwd: dir.cwd })
		const isConflicting = mergeable === 'CONFLICTING'
		let behindDefault = false
		if (!isConflicting) {
			behindDefault = yield* isBranchBehindDefault({
				branch: pr.headRefName,
				defaultBranch: config.defaultBranch,
				cwd: dir.cwd
			})
		}

		let hasContentChanges = false
		if (!isConflicting && !behindDefault) {
			const branchFiles = new Map<string, string | null>()
			for (const relPath of branchUpdate.affectedFiles) {
				const content = yield* readBranchFile({
					branch: pr.headRefName,
					relPath,
					cwd: dir.cwd
				})
				branchFiles.set(relPath, content)
			}
			hasContentChanges = plan.isOutdated({ branchFiles })
		}

		if (!isConflicting && !behindDefault && !hasContentChanges) {
			yield* Effect.logInfo(
				`  PR #${pr.number} (${pr.headRefName}) is up to date`
			)
			// Re-arm rather than skip: this picks up PRs opened before autoMerge
			// was turned on, and retries any earlier attempt that failed.
			if (config.autoMerge.enabled) {
				yield* enableAutoMerge({ prRef: String(pr.number), config, dir })
			}
			continue
		}

		let reason = 'outdated content'
		if (isConflicting) {
			reason = 'conflicting'
		} else if (behindDefault) {
			reason = `behind ${config.defaultBranch}`
		}
		yield* Effect.logInfo(
			`\n  Rebuilding PR #${pr.number} (${pr.headRefName}) — ${reason}`
		)

		// A fatal checkout failure while rebuilding must not abort the whole
		// sync; log it and move on to the next PR.
		const outcome = yield* Effect.result(
			updateBranch({ branchUpdate, config, dir })
		)
		if (outcome._tag === 'Failure') {
			yield* Effect.logError(
				`  Error rebuilding PR #${pr.number} (${pr.headRefName}): ${String(outcome.failure)}`
			)
			continue
		}
		if (!outcome.success) {
			yield* Effect.logError(
				`  Failed to rebuild PR #${pr.number} (${pr.headRefName})`
			)
			continue
		}

		const editResult = yield* commands.exec(
			[
				'gh',
				'pr',
				'edit',
				String(pr.number),
				'--title',
				branchUpdate.title,
				'--body',
				branchUpdate.body
			],
			{ cwd: dir.cwd }
		)

		if (editResult.exitCode !== 0) {
			yield* Effect.logWarning(
				`  Warning: Failed to update title/body for PR #${pr.number}, but branch was rebuilt`
			)
		}

		// The rebuild force-pushes the branch, so arm the PR again.
		if (config.autoMerge.enabled) {
			yield* enableAutoMerge({ prRef: String(pr.number), config, dir })
		}

		yield* Effect.logInfo(
			`  Successfully rebuilt PR #${pr.number} (${pr.headRefName})`
		)
		rebuiltCount++
	}

	return { closedCount, rebuiltCount }
})
