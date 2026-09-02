# AGENTS.md

## Project Overview

GitHub Action + CLI (`catalog-update`) that automates dependency updates for the `catalog:` protocol in monorepos — supports Bun, pnpm, and Yarn catalogs. Queries npm for latest versions, groups updates into batches, creates/syncs PRs via GitHub CLI, and detects vulnerable transitive dependencies via each manager's audit (`bun audit`, `pnpm audit`, `yarn npm audit`). Replaces Dependabot for catalog-based workspaces.

Runs directly from `src/` via Bun — no build step. Published to npm as `catalog-update-action`; requires **Bun >= 1.4.0**. The action is dogfooded by this repo's own `.github/workflows/catalog-update.yml` (`uses: ./`, daily schedule).

The codebase is written in **Effect v4** (`effect@4.0.0-rc` + `@effect/platform-bun`, pinned exact): workflows are `Effect.gen`/`Effect.fn`, errors are typed `Schema.TaggedError`s, and all I/O goes through services — `Commands` (git/gh/install/audit via `ChildProcessSpawner`), `FileSystem`, `Registry` (npm/GitHub HTTP via `HttpClient`), with a plain-text `Logger` layer so CLI output stays human-readable. zod is gone; every boundary is decoded with Effect `Schema` (`Schema.decodeUnknownOption`/`Effect`), and each literal vocabulary (severity, semver change, mergeable state, merge method) is one schema with a derived type in `src/schemas.ts`. Providers (`src/providers/`) stay deliberately pure string→string functions; their throws are mapped into `BranchApplyError` by the apply adapters.

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

oxlint (type-aware) + oxfmt, configured in `.oxlintrc.json` / `.oxfmtrc.json`. The Effect plugin (`oxlint-plugin-effect`) enforces Effect discipline (typed errors, no try/catch, no `new Error`, no globals in application code). Rule suppressions are targeted `oxlint-disable-next-line` comments at the exact sites that need them (the provider throw contract, the logger's console writes, discovery's `Bun.Glob`, the registry's date parsing, the JSON codec and unknown-typed schema params, `Schema.TaggedError` declarations, and main's async entry); only the process boundary (`src/main.ts` globals) and test fixtures keep per-path overrides. Formatting is enforced by a pre-commit hook (`.githooks/`, enabled by the `prepare` script) that auto-fixes fmt + lint on commit. CI enforces `bun run lint` and `bun test` on PRs.

## Project Structure

```
src/                       # TypeScript source (entry: main.ts)
src/commands.ts            # Commands service — exec adapter over ChildProcessSpawner (silent; exit code is data, spawn failures are defects)
src/logging.ts             # Plain-text logger layer (info→stdout, warn/error→stderr)
src/registry.ts            # Registry service — npm registry + GitHub releases over HttpClient
src/release-age.ts         # Pure release-age quarantine policy (minReleaseAgeDays filtering)
src/release-notes.ts       # Pure release-note clamping + PR-body rendering
src/git.ts, src/audit.ts   # git/gh and audit workflows over Commands + FileSystem
src/pipeline.ts            # processCatalog — per-location orchestration
src/providers/             # Per-manager catalog adapters (bun, pnpm, yarn) — parsing, install, audit capability
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
