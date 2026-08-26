# AGENTS.md

## Project Overview

GitHub Action + CLI (`catalog-update`) that automates dependency updates for Bun's `catalog:` protocol in monorepos. Queries npm for latest versions, groups updates into batches, creates/syncs PRs via GitHub CLI, and detects vulnerable transitive dependencies via `bun audit`. Replaces Dependabot for Bun workspace catalogs.

Runs directly from `src/` via Bun — no build step. Published to npm as `catalog-update-action`; requires **Bun >= 1.4.0**. The action is dogfooded by this repo's own `.github/workflows/catalog-update.yml` (`uses: ./`, daily schedule).

## Commands

```sh
bun install        # Install deps; runs `prepare` which enables the .githooks pre-commit hook
bun run start      # Run the action locally (bun src/main.ts)
bun run dry-run    # Preview updates without creating PRs
bun test           # Run all tests (bun:test)
bun run lint       # oxlint --type-aware src/
bun run fmt        # oxfmt src/
bun run fmt:check  # oxfmt --check src/
```

Entry point: `src/main.ts`.

## Linting & Formatting

oxlint (type-aware) + oxfmt, configured in `.oxlintrc.json` / `.oxfmtrc.json`. Formatting is enforced by a pre-commit hook (`.githooks/`, enabled by the `prepare` script) that auto-fixes fmt + lint on commit. CI enforces `bun run lint` and `bun test` on PRs.

## Project Structure

```
src/                       # TypeScript source (entry: main.ts)
test/                      # bun:test tests, mirror src/ names (src/catalog.ts -> test/catalog.test.ts)
action.yml                 # GitHub Action definition (composite; inputs: config, dry-run, token, exclude-directories, bun-version)
schema.json                # JSON Schema for .catalog-updaterc.json
.githooks/                 # pre-commit hook (oxfmt --write + oxlint --fix on src/)
.github/workflows/         # ci, pr-gate, release, catalog-update
```

Dev deps are pinned via a top-level `catalog:` in package.json (with `workspaces: []`); `bunfig.toml` sets `[install] exact = true`. `bun.lock` is committed.

## Commit & Release Conventions

- Commits and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, `type` one of `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`. Use `!` or a `BREAKING CHANGE:` footer for breaking changes. Enforced by the **PR Gate** workflow (`.github/workflows/pr-gate.yml`).
- Releases are automated by [release-please](https://github.com/googleapis/release-please-action): merging Conventional Commits to `master` opens a release PR titled `chore(master): release ...`; merging it publishes to npm (OIDC/provenance) and force-updates the `v1` tag.
- `CLAUDE.md` is a symlink to this file.
