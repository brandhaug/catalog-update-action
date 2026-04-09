# catalog-update-action

Automated dependency updates for Bun's `catalog:` protocol. Replaces Dependabot for monorepos using [Bun workspaces](https://bun.sh/docs/install/workspaces) with a centralized [catalog](https://bun.sh/docs/install/workspaces#versioning).

[![npm version](https://img.shields.io/npm/v/catalog-update-action)](https://www.npmjs.com/package/catalog-update-action)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why

Dependabot doesn't understand Bun's `catalog:` protocol — it can't update the centralized version catalog in your root `package.json`. This action fills that gap.

### Features

- Reads the `catalog` field from `package.json`, extracting package names and current versions
- Auto-discovers multiple catalog directories in monorepos
- Queries npm for the latest stable versions (skips pre-releases)
- Groups updates into batches based on configurable patterns (similar to Dependabot groups)
- Creates and syncs PRs via the GitHub CLI — closes stale ones, rebuilds conflicting ones
- Includes release notes from GitHub Releases in PR descriptions
- Supports `^` ranges and `npm:` aliases
- Detects vulnerable transitive dependencies via `bun audit` and creates override PRs
- Runs as a GitHub Action or standalone CLI

## Prerequisites

- [Bun](https://bun.sh) runtime
- `gh` CLI (pre-installed on GitHub Actions runners)
- `GITHUB_TOKEN` with `contents: write` and `pull-requests: write` permissions

## Usage

### GitHub Action

```yaml
# .github/workflows/catalog-update.yml
name: Catalog Updates
on:
  schedule:
    - cron: '0 6 * * 1-5'  # Weekdays at 06:00 UTC
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: brandhaug/catalog-update-action@v1
        with:
          config: '.catalog-updaterc.json'
          dry-run: 'false'
```

> **Tip:** PRs created with the default `GITHUB_TOKEN` won't trigger downstream workflows (e.g., CI checks). To fix this, use a GitHub App token:
>
> ```yaml
> steps:
>   - uses: actions/create-github-app-token@v1
>     id: app-token
>     with:
>       app-id: ${{ secrets.APP_ID }}
>       private-key: ${{ secrets.APP_PRIVATE_KEY }}
>
>   - uses: actions/checkout@v4
>     with:
>       fetch-depth: 0
>       token: ${{ steps.app-token.outputs.token }}
>
>   - uses: brandhaug/catalog-update-action@v1
>     with:
>       token: ${{ steps.app-token.outputs.token }}
> ```

#### Action Inputs

| Input | Default | Description |
| --- | --- | --- |
| `config` | `.catalog-updaterc.json` | Path to the config file (relative to each discovered directory) |
| `dry-run` | `false` | Preview updates without creating PRs |
| `token` | `github.token` | GitHub token for creating PRs. Use a PAT or GitHub App token to trigger downstream workflows |
| `exclude-directories` | `''` | Comma-separated directories to exclude from catalog discovery (supports glob patterns) |

### CLI

```bash
# Run via bunx (no install needed)
bunx catalog-update-action --dry-run

# Or via npx
npx catalog-update-action --dry-run

# Install globally
bun add -g catalog-update-action
catalog-update --dry-run

# Full run (creates PRs)
catalog-update

# Custom config path
catalog-update -c path/to/.catalog-updaterc.json
```

#### CLI Options

| Flag | Short | Description |
| --- | --- | --- |
| `--help` | `-h` | Show help message and exit |
| `--version` | `-v` | Show version and exit |
| `--dry-run` | `-d` | Preview updates without creating PRs |
| `--config <path>` | `-c` | Path to config file (default: `.catalog-updaterc.json`) |
| `--exclude <dirs>` | `-e` | Comma-separated directories to exclude from catalog discovery (supports glob patterns) |

## Multi-Directory Support

The action automatically discovers all directories containing a `package.json` with a `catalog` field — not just the repo root. This is useful for monorepos that maintain separate catalogs in subdirectories.

Each discovered directory is processed independently with its own config file, and PR branches are namespaced by directory (e.g., `catalog-update/apps/web/react`).

To exclude directories from discovery:

```yaml
# GitHub Action
- uses: brandhaug/catalog-update-action@v1
  with:
    exclude-directories: 'apps/legacy,packages/deprecated-*'
```

```bash
# CLI
catalog-update --exclude "apps/legacy,packages/deprecated-*"
```

## Configuration

Create a `.catalog-updaterc.json` in your repository root:

```json
{
  "$schema": "https://raw.githubusercontent.com/brandhaug/catalog-update-action/master/schema.json",
  "branchPrefix": "catalog-update",
  "defaultBranch": "master",
  "maxOpenPrs": 20,
  "concurrency": 10,
  "packageManager": "bun",
  "minReleaseAgeDays": 3,
  "groups": [
    { "name": "react", "patterns": ["react", "react-dom"] },
    { "name": "vite", "patterns": ["vite", "vitest", "@vitejs/*", "@vitest/*"] },
    { "name": "storybook", "patterns": ["@storybook/*", "storybook*"] },
    { "name": "all-patch-updates", "patterns": ["*"], "updateTypes": ["patch"] }
  ],
  "ignore": [
    { "pattern": "*storybook*", "updateTypes": ["major"] }
  ],
  "audit": {
    "enabled": true,
    "minimumSeverity": "moderate"
  }
}
```

> **Tip:** Add the `$schema` field to get autocomplete and validation in your IDE.

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `branchPrefix` | `string` | `"catalog-update"` | Prefix for PR branches (e.g., `catalog-update/react`) |
| `defaultBranch` | `string` | `"master"` | Base branch for PRs |
| `maxOpenPrs` | `number` | `20` | Maximum number of open PRs at any time |
| `concurrency` | `number` | `10` | Max concurrent npm registry requests |
| `packageManager` | `string` | `"bun"` | Package manager for lockfile updates (`bun`, `npm`, `pnpm`, `yarn`) |
| `minReleaseAgeDays` | `number` | `0` | Minimum days a release must be published before creating a PR (supply chain protection). `0` = disabled. Does not apply to audit overrides |
| `groups` | `array` | `[]` | Dependency grouping rules (see below) |
| `ignore` | `array` | `[]` | Dependency ignore rules (see below) |
| `audit` | `object` | `{}` | Transitive vulnerability audit settings (see below) |

### Groups

Groups control how updates are batched into PRs. Each group has:

- **`name`** — Group identifier, used in branch names and PR titles
- **`patterns`** — Glob patterns to match package names (`*` wildcard supported)
- **`updateTypes`** (optional) — Restrict to specific semver change types: `"major"`, `"minor"`, `"patch"`. Omit to match all types

Groups are evaluated in order — first match wins. A common pattern is to have specific groups first and a catch-all `all-patch-updates` group last:

```json
{
  "groups": [
    { "name": "react", "patterns": ["react", "react-dom"] },
    { "name": "testing-library", "patterns": ["@testing-library/*"] },
    { "name": "all-patch-updates", "patterns": ["*"], "updateTypes": ["patch"] }
  ]
}
```

Packages not matched by any group get individual PRs.

**Patch collapse:** If a named group (e.g. `sentry`) contains only patch updates and no minor or major updates, its members are automatically moved into `all-patch-updates` instead of getting a separate PR. This reduces PR noise — a dedicated group PR is only created when it has at least one minor or major update. For this to work, you need an `all-patch-updates` catch-all group with `"updateTypes": ["patch"]` as the last group.

### Ignore Rules

Ignore rules prevent certain updates from being created:

- **`pattern`** — Glob pattern to match package names
- **`updateTypes`** (optional) — Only ignore specific change types. Omit to ignore all updates for matched packages

```json
{
  "ignore": [
    { "pattern": "*storybook*", "updateTypes": ["major"] },
    { "pattern": "typescript" }
  ]
}
```

### Minimum Release Age

As a supply chain security measure, you can require releases to be published for a minimum number of days before the action creates a PR. This quarantine period gives the community time to discover and flag compromised packages.

```json
{
  "minReleaseAgeDays": 3
}
```

When the latest version is too young, the action falls back to the newest published version that meets the age requirement. If no version qualifies, the package is skipped entirely. Vulnerability audit overrides are **not** affected by this setting — security fixes are never delayed.

### Vulnerability Audit

When enabled, the action runs `bun audit --json` to detect vulnerable transitive dependencies and creates a PR that adds [`overrides`](https://bun.sh/docs/install/overrides) to your `package.json`, pinning transitive dependencies to patched versions.

- **`enabled`** — Enable or disable the audit pipeline (default: `true`)
- **`minimumSeverity`** — Minimum advisory severity to act on: `"info"`, `"low"`, `"moderate"`, `"high"`, `"critical"` (default: `"moderate"`)

```json
{
  "audit": {
    "minimumSeverity": "high"
  }
}
```

To disable the audit entirely:

```json
{
  "audit": {
    "enabled": false
  }
}
```

The override PR is created with security priority (before catalog PRs) and shares the same `maxOpenPrs` budget. Direct catalog dependencies are excluded from overrides since they are handled by the catalog update pipeline.

## How It Works

1. **Discover** — Scans the repository for all directories containing a `package.json` with a `catalog` field
2. **Parse** — Reads the `catalog` field from each `package.json`, extracting package names and current versions (supports `^` ranges and `npm:` aliases)
3. **Query** — Fetches latest stable versions from the npm registry (skips pre-releases)
4. **Filter** — Applies ignore rules, classifies updates as major/minor/patch, and enforces minimum release age (if configured)
5. **Group** — Assigns updates to configured groups; unmatched packages get individual PRs
6. **Audit** — If audit is enabled, runs `bun audit --json` to find vulnerable transitive dependencies and computes required overrides
7. **Sync** — For existing PRs: closes stale ones, rebuilds conflicting or outdated ones
8. **Create** — Creates new PRs (override PR first for security priority, then catalog PRs), respecting the `maxOpenPrs` limit

Each catalog PR includes:
- A table of all updated packages with version changes
- Release notes fetched from GitHub Releases (with intermediate version support for monorepos)

Each override PR includes:
- A summary table of overridden packages with fixed versions and advisory links
- Collapsible advisory details (severity, CVSS score, CWE, vulnerable version ranges)

## Contributing

Contributions are welcome! To get started:

```bash
git clone https://github.com/brandhaug/catalog-update-action.git
cd catalog-update-action
bun install
bun test
bun run lint    # oxlint
bun run fmt     # oxfmt
```

## License

MIT — see [`LICENSE`](LICENSE) for details.
