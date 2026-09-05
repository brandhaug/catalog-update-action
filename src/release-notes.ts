import { type UpdateCandidate, type VersionReleaseNote } from './types'

/**
 * Release-note presentation: how fetched GitHub release bodies are clamped
 * and rendered into a PR body. Pure string shaping, shared by the registry
 * service (which truncates note bodies as it fetches them) and the catalog
 * PR builder (which renders the section).
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

/**
 * Defuse `@mentions` so upstream release notes do not notify every contributor
 * of the dependency when the PR body is posted. The empty HTML comment renders
 * away, so the text still reads as `@name` but GitHub does not link or notify.
 */
export function escapeMentions(body: string): string {
	return body.replace(MENTION_PATTERN, '$1@<!---->$2')
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
				`<summary><b>${u.name}</b> (${u.currentVersion} → ${u.latestVersion})</summary>`,
				'',
				escapeMentions(firstNote.body),
				'',
				'</details>',
				''
			)
		} else {
			lines.push(
				'<details>',
				`<summary><b>${u.name}</b> (${u.currentVersion} → ${u.latestVersion}) — ${versionNotes.length} releases</summary>`,
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
