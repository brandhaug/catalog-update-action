# AGENTS.md

## Project Overview

GitHub Action and CLI tool that automates dependency updates for Bun's `catalog:` protocol in monorepos. Replaces Dependabot for Bun workspace catalogs. Queries npm for latest versions, groups updates into batches, creates/syncs PRs via GitHub CLI, and detects vulnerable transitive dependencies via `bun audit`.

- **Runtime:** Bun (TypeScript, ESNext, ES modules)
- **No build step** -- code runs directly from `src/` via Bun
- **Published to npm** as `catalog-update-action` with bin `catalog-update`

## Setup Commands

```sh
bun install          # Install dependencies
```

## Development Workflow

```sh
bun run start        # Run the action locally (bun src/main.ts)
bun run dry-run      # Preview updates without creating PRs
```

Entry point: `src/main.ts`. No build/compile step needed.

## Testing

```sh
bun test             # Run all tests (bun:test framework)
```

Tests are in `test/` and mirror `src/` filenames (e.g. `src/catalog.ts` -> `test/catalog.test.ts`).

## Linting and Formatting

Uses **oxlint** (type-aware) and **oxfmt** (Rust-based formatter). Config files: `.oxlintrc.json`, `.oxfmtrc.json`.

```sh
bun run lint         # Lint with oxlint (type-aware, src/)
bun run fmt          # Format with oxfmt (src/)
bun run fmt:check    # Check formatting without modifying
```

## Project Structure

```
src/           # TypeScript source (entry: main.ts)
test/          # Tests (bun:test, mirrors src/ names)
action.yml     # GitHub Action definition
schema.json    # JSON Schema for .catalog-updaterc.json
```
## Commit & Release Conventions

- **All commits and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/)**: `type(scope): subject`, where `type` is one of `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`. Use `!` or a `BREAKING CHANGE:` footer for breaking changes.
- This convention is enforced by the **PR Gate** workflow (`.github/workflows/pr-gate.yml`), which fails any PR whose title does not conform.
- Releases are automated by [release-please](https://github.com/googleapis/release-please-action): merging Conventional Commits to `master` opens a release PR titled `chore(master): release ...`; merging it tags and publishes the release.
- `CLAUDE.md` is a symlink to this file so Claude Code reads the same conventions.

