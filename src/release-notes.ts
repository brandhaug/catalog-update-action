import { type UpdateCandidate, type VersionReleaseNote } from './types'

/**
 * Release-note presentation: how fetched GitHub release bodies are clamped,
 * defused, and rendered into a PR body. Pure string shaping, shared by the
 * registry service (which truncates note bodies as it fetches them) and the
 * catalog PR builder (which renders the section).
 */

/** Longest single note body included in a PR before linking to the full notes. */
const RELEASE_NOTES_MAX_LENGTH = 2000
/** Longest combined release-notes section in a PR body. */
const COMBINED_RELEASE_NOTES_MAX_LENGTH = 5000

/**
 * Matches a GitHub user or team mention: an `@` that is not preceded by a word
 * character (so emails like `a@b.com` are left alone), followed by a login and
 * an optional `/team` segment.
 */
const MENTION_PATTERN =
	/(^|[^\w@/])@([a-zA-Z0-9][a-zA-Z0-9-]{0,38}(?:\/[a-zA-Z0-9._-]{1,80})?)/g

/** Opening code fence at the start of a line: ``` or ~~~, three or more. */
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/

/** A stretch of markdown that either renders as code or as prose. */
type CodeSegment = {
	readonly text: string
	readonly code: boolean
}

/**
 * Split a markdown body into prose and code segments, tracking fenced code
 * blocks and inline code spans (which may run across lines, and close only on
 * a backtick run of the same length that opened them). An unclosed backtick
 * run is prose, as in CommonMark.
 *
 * Indented (4-space) code blocks are not tracked; mentions inside them stay
 * escaped, which at worst leaves the defusing marker visible in rare notes.
 */
function splitCodeSegments(body: string): Array<CodeSegment> {
	const segments: Array<CodeSegment> = []
	const append = (text: string, code: boolean): void => {
		if (text.length === 0) {
			return
		}
		const last = segments.at(-1)
		if (last === undefined || last.code !== code) {
			segments.push({ text, code })
			return
		}
		segments[segments.length - 1] = { text: last.text + text, code }
	}

	const lines = body.split('\n')
	/** Closes the fence we are inside, or null in prose. */
	let fenceCloser: RegExp | null = null
	/** Backtick-run length that closes the open inline code span, else 0. */
	let closer = 0
	/** Text inside the still-open inline code span. */
	let pending = ''

	for (const [index, line] of lines.entries()) {
		const raw = index < lines.length - 1 ? `${line}\n` : line

		if (fenceCloser !== null) {
			// Only a line that is nothing but the same marker, at least as
			// long as the opening run, closes the fence.
			if (fenceCloser.test(line)) {
				fenceCloser = null
			}
			append(raw, true)
			continue
		}

		const open = closer === 0 ? line.match(FENCE_OPEN_PATTERN) : null
		if (open) {
			fenceCloser = new RegExp(
				`^ {0,3}${open[1][0]}{${open[1].length},}[ \t\r]*$`
			)
			append(raw, true)
			continue
		}

		let start = 0
		while (start < raw.length) {
			const tick = raw.indexOf('`', start)
			const textEnd = tick === -1 ? raw.length : tick
			if (closer === 0) {
				append(raw.slice(start, textEnd), false)
			} else {
				pending += raw.slice(start, textEnd)
			}
			if (tick === -1) {
				break
			}
			let runEnd = tick
			while (runEnd < raw.length && raw[runEnd] === '`') {
				runEnd++
			}
			const run = raw.slice(tick, runEnd)
			if (closer === 0) {
				closer = run.length
				pending = run
			} else if (run.length === closer) {
				append(`${pending}${run}`, true)
				pending = ''
				closer = 0
			} else {
				pending += run
			}
			start = runEnd
		}
	}

	// An inline code span that never closed renders as literal text.
	if (closer > 0) {
		append(pending, false)
	}

	return segments
}

/**
 * Defuse `@mentions` so upstream release notes do not notify every contributor
 * of the dependency when the PR body is posted. The empty HTML comment renders
 * away, so the text still reads as `@name` but GitHub does not link or notify.
 * Mentions inside code (which GitHub never notifies, and where the marker
 * would show up as literal text) are left untouched.
 */
export function escapeMentions(body: string): string {
	return splitCodeSegments(body)
		.map((segment) =>
			segment.code
				? segment.text
				: segment.text.replace(MENTION_PATTERN, '$1@<!---->$2')
		)
		.join('')
}

/** Clamp one note body, linking to the full notes when it is cut. */
export function clampNoteBody({
	body,
	releaseUrl
}: {
	body: string
	releaseUrl: string
}): string {
	if (body.length <= RELEASE_NOTES_MAX_LENGTH) {
		return body
	}
	return `${body.slice(0, RELEASE_NOTES_MAX_LENGTH)}\n\n…[full notes](${releaseUrl})`
}

/** Build the release notes section for a PR body. */
export function formatReleaseNotes({
	updates,
	releaseNotes
}: {
	updates: Array<UpdateCandidate>
	releaseNotes: Map<string, Array<VersionReleaseNote>>
}): Array<string> {
	const sorted = [...updates].toSorted((a, b) => a.name.localeCompare(b.name))
	const notesEntries = sorted.filter((u) => releaseNotes.has(u.name))

	if (notesEntries.length === 0) {
		return []
	}

	const lines: Array<string> = ['', '## Release Notes', '']

	for (const u of notesEntries) {
		const versionNotes = releaseNotes.get(u.name)
		if (!versionNotes || versionNotes.length === 0) {
			continue
		}

		const firstNote = versionNotes[0]
		if (firstNote && versionNotes.length === 1) {
			lines.push(
				'<details>',
				`<summary><b>${escapeMentions(u.name)}</b> (${u.currentVersion} → ${u.latestVersion})</summary>`,
				'',
				escapeMentions(firstNote.body),
				'',
				'</details>',
				''
			)
		} else {
			lines.push(
				'<details>',
				`<summary><b>${escapeMentions(u.name)}</b> (${u.currentVersion} → ${u.latestVersion}) — ${versionNotes.length} releases</summary>`,
				''
			)

			let cumulativeLength = 0
			let rendered = 0
			for (const note of versionNotes) {
				if (
					cumulativeLength + note.body.length >
					COMBINED_RELEASE_NOTES_MAX_LENGTH
				) {
					const remaining = versionNotes.length - rendered
					lines.push(
						`<p><i>…and ${remaining} more release(s) not shown</i></p>`,
						''
					)
					break
				}

				lines.push(
					'<details>',
					`<summary><b>${note.version}</b></summary>`,
					'',
					escapeMentions(note.body),
					'',
					'</details>',
					''
				)
				cumulativeLength += note.body.length
				rendered++
			}

			lines.push('</details>', '')
		}
	}

	return lines
}
