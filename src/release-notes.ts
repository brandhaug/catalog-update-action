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
				firstNote.body,
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
					note.body,
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
