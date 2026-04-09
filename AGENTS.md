# AGENTS.md

## Project Overview

GitHub Action and CLI tool that automates dependency updates for Bun's `catalog:` protocol in monorepos. Replaces Dependabot for Bun workspace catalogs. Queries npm for latest versions, groups updates into batches, creates/syncs PRs via GitHub CLI, and detects vulnerable transitive dependencies via `bun audit`.

- **Runtime:** Bun (TypeScript, ESNext, ES modules)
- **No build step** -- code runs directly from `src/` via Bun
- **Published to npm** as `catalog-update-action` with bin `catalog-update`

## Setup Commands

```sh
bun install          # Install dependencies
bun run prepare      # Configure git hooks path (.githooks/)
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

Pre-commit hook (`.githooks/pre-commit`) auto-runs `oxfmt --write` and `oxlint --fix` on staged files.

## Code Style

- Tabs for indentation, single quotes, no semicolons, trailing comma: none
- Strict TypeScript: `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`
- Oxlint rules: no-param-reassign (error), no-else-return (error), prefer-as-const, no-inferrable-types

## CI Pipeline

Runs on PRs to `master` (`.github/workflows/ci.yml`):

1. `bun install`
2. `bun run lint`
3. `bun run fmt:check`
4. `bun test`

All four must pass before merge.

## Release

Uses **Release Please** on push to `master` (`.github/workflows/release.yml`). Publishes to npm with provenance. Updates `v1` tag for GitHub Action consumers.

## PR Guidelines

- All PRs target `master`
- Run `bun run lint`, `bun run fmt:check`, and `bun test` before pushing
- Commit messages follow conventional commits (Release Please requirement)

## Project Structure

```
src/           # TypeScript source (entry: main.ts)
test/          # Tests (bun:test, mirrors src/ names)
.githooks/     # Pre-commit hook (oxfmt + oxlint)
.github/       # CI and release workflows
action.yml     # GitHub Action definition
schema.json    # JSON Schema for .catalog-updaterc.json
```
