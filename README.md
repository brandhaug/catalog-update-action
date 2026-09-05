# catalog-update-action

Automated dependency updates for the `catalog:` protocol. Replaces Dependabot for monorepos that centralize dependency versions in a catalog — [Bun](https://bun.com/docs/pm/catalogs), [pnpm](https://pnpm.io/catalogs), and [Yarn](https://yarnpkg.com/features/catalogs) are all supported.

[![npm version](https://img.shields.io/npm/v/catalog-update-action)](https://www.npmjs.com/package/catalog-update-action)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why

Dependabot doesn't understand the `catalog:` protocol, so it can't update the centralized version catalog in your monorepo. This action fills that gap.

- Reads catalog definitions from `package.json` (`catalog`/`catalogs`, Bun), `pnpm-workspace.yaml` (pnpm), or `.yarnrc.yml` (Yarn) — auto-discovered, including named catalogs
- Queries npm for the latest stable versions and groups updates into configurable batches
- Creates and syncs PRs via the GitHub CLI — closes stale ones, rebuilds conflicting ones, and includes GitHub Releases notes
- Detects vulnerable transitive dependencies via the package manager's audit and creates override PRs (bun/pnpm → `overrides`, yarn → `resolutions`)
- Optionally enforces a minimum release age (supply chain protection) and turns on GitHub auto-merge
- Runs as a GitHub Action or a standalone CLI

## Supported package managers

| Manager | Catalog definition | Default catalog | Named catalogs | Install | Vulnerability audit |
| --- | --- | --- | --- | --- | --- |
| Bun | `package.json` → `catalog` / `catalogs` | ✓ | ✓ | `bun install` | ✓ (`bun audit`) |
| pnpm | `pnpm-workspace.yaml` → `catalog` / `catalogs` | ✓ | ✓ | `pnpm install` | ✓ (`pnpm audit`) |
| Yarn (Berry 4+) | `.yarnrc.yml` → `catalog` / `catalogs` | ✓ | ✓ | `yarn install` | ✓ (`yarn npm audit`) |

The package manager is detected from the definition file that declares the catalog — there is no `packageManager` config option (it was removed; existing configs that set it are ignored with a warning).

## Prerequisites

- [Bun](https://bun.sh) runtime (used to run this action; Bun catalogs also use it to install)
- The package manager matching your catalogs (`pnpm` / `yarn`) available on the runner for non-Bun catalogs
- `gh` CLI (pre-installed on GitHub Actions runners)
- A GitHub token with `contents: write` and `pull-requests: write` permissions

## Usage

### GitHub Action

```yaml
# .github/workflows/catalog-update.yml
name: Catalog Updates
on:
  schedule:
    - cron: '0 6 * * 1-5'  # Weekdays at 06:00 UTC
  push:
    branches:
      - master
    paths:
      - '**/package.json'
      - '**/pnpm-workspace.yaml'
      - '**/.yarnrc.yml'
      - '**/bun.lock'
      - '**/pnpm-lock.yaml'
      - '**/yarn.lock'
  workflow_dispatch:

# Rebuilds of open update PRs must run one at a time; queued (not cancelled)
# runs are what let the cascade converge after each merge.
concurrency:
  group: catalog-update
  cancel-in-progress: false

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
```

> **Tip:** The `push` trigger makes the action rebuild open PRs immediately after every merge to the default branch. With auto-merge enabled this cascades — each merge rebuilds the remaining PRs, their CI runs, they merge, and the process repeats until all groups are up to date — instead of waiting for the next scheduled run.

> **Tip:** PRs created with the default `GITHUB_TOKEN` won't trigger downstream workflows (e.g. CI checks). Use a [GitHub App token](https://github.com/actions/create-github-app-token) instead:
>
> ```yaml
> - uses: actions/create-github-app-token@v1
>   id: app-token
>   with:
>     app-id: ${{ secrets.APP_ID }}
>     private-key: ${{ secrets.APP_PRIVATE_KEY }}
>
> - uses: actions/checkout@v4
>   with:
>     fetch-depth: 0
>     token: ${{ steps.app-token.outputs.token }}
>
> - uses: brandhaug/catalog-update-action@v1
>   with:
>     token: ${{ steps.app-token.outputs.token }}
> ```

#### Action Inputs

| Input | Default | Description |
| --- | --- | --- |
| `config` | `.catalog-updaterc.json` | Path to the config file (relative to each discovered directory) |
| `dry-run` | `false` | Preview updates without creating PRs |
| `token` | `github.token` | GitHub token for creating PRs. Use a PAT or GitHub App token to trigger downstream workflows |
| `exclude-directories` | `''` | Comma-separated directories to exclude from catalog discovery (supports glob patterns) |
| `bun-version` | `1.4.2` | Bun version used to resolve and install dependencies. Match your project's Bun — Bun 1.4+ writes a lockfile format unreadable by Bun <= 1.3 |

### CLI

```bash
bunx catalog-update-action --dry-run   # preview without installing
catalog-update                         # full run (creates PRs)
catalog-update -c path/to/config.json  # custom config path
```

Install globally with `bun add -g catalog-update-action` to use the `catalog-update` binary.

#### CLI Options

| Flag | Short | Description |
| --- | --- | --- |
| `--help` | `-h` | Show help message and exit |
| `--version` | `-v` | Show version and exit |
| `--dry-run` | `-d` | Preview updates without creating PRs |
| `--config <path>` | `-c` | Path to config file (default: `.catalog-updaterc.json`) |
| `--exclude <dirs>` | `-e` | Comma-separated directories to exclude from catalog discovery (supports glob patterns) |

## Configuration

Create a `.catalog-updaterc.json` in your repository root:

```json
{
  "$schema": "https://raw.githubusercontent.com/brandhaug/catalog-update-action/master/schema.json",
  "branchPrefix": "catalog-update",
  "defaultBranch": "master",
  "maxOpenPrs": 20,
  "concurrency": 10,
  "minReleaseAgeDays": 3,
  "groups": [
    { "name": "react", "patterns": ["react", "react-dom"] },
    { "name": "all-patch-updates", "patterns": ["*"], "updateTypes": ["patch"] }
  ],
  "ignore": [],
  "audit": {
    "enabled": true,
    "minimumSeverity": "moderate"
  },
  "autoMerge": {
    "enabled": false,
    "mergeMethod": "squash"
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
| `minReleaseAgeDays` | `number` | `0` | Minimum days a release must be published before creating a PR (supply chain protection). `0` = disabled. Does not apply to audit overrides |
| `groups` | `array` | `[]` | Dependency grouping rules |
| `ignore` | `array` | `[]` | Dependency ignore rules |
| `audit` | `object` | `{}` | Transitive vulnerability audit settings (Bun catalogs only) |
| `autoMerge` | `object` | `{}` | GitHub auto-merge settings |

### Groups

Groups batch updates into PRs. Each group has a `name`, `patterns` (glob patterns, `*` wildcard supported), and an optional `updateTypes` list restricted to `"major"`, `"minor"`, or `"patch"`. Groups are evaluated in order — first match wins — so put specific groups first and a catch-all `all-patch-updates` group last. Packages not matched by any group get individual PRs.

Patch updates in a named group collapse into `all-patch-updates` unless the group has a minor or major update, reducing PR noise.

```json
{
  "groups": [
    { "name": "react", "patterns": ["react", "react-dom"] },
    { "name": "all-patch-updates", "patterns": ["*"], "updateTypes": ["patch"] }
  ]
}
```

### Ignore Rules

Ignore rules prevent updates for matching packages. `pattern` is a glob; `updateTypes` optionally limits which change types are ignored (omit to ignore all).

```json
{
  "ignore": [
    { "pattern": "*storybook*", "updateTypes": ["major"] },
    { "pattern": "typescript" }
  ]
}
```

### Minimum Release Age

Require releases to be published for a minimum number of days before the action creates a PR, giving the community time to flag compromised packages. When the latest version is too young, the action falls back to the newest version that meets the age requirement, or skips the package entirely. Audit overrides are never delayed by this setting.

```json
{ "minReleaseAgeDays": 3 }
```

### Vulnerability Audit

Runs the package manager's audit (`bun audit`, `pnpm audit`, or `yarn npm audit`) to detect vulnerable transitive dependencies and creates a PR pinning them to patched versions. Configure with `enabled` (default `true`) and `minimumSeverity` (`"info"`, `"low"`, `"moderate"`, `"high"`, `"critical"`; default `"moderate"`).

```json
{ "audit": { "enabled": false } }
```

Where the pins land depends on the manager:

| Manager | Override file | Key format |
| --- | --- | --- |
| Bun | `package.json` → `overrides` | `pkg@<vulnerable-range>: <fixed>` |
| pnpm | `pnpm-workspace.yaml` → `overrides` | `pkg@<vulnerable-range>: <fixed>` |
| Yarn | `package.json` → `resolutions` | `pkg: <fixed>` |

Note the Yarn differences: `resolutions` selectors are keyed by package name (Yarn ignores range selectors), so multiple advisory ranges for one package collapse into the highest fixed version. Entries are treated as tool-managed when their value is an exact semver version (the format this action writes); range-valued entries are always treated as user-owned and preserved — but that also means stale exact pins for packages that are no longer vulnerable get cleaned up on the next run. Keep user resolutions range-valued if you want them left alone.

Override PRs are created with security priority (before catalog PRs), share the `maxOpenPrs` budget, and exclude direct catalog dependencies (handled by the catalog pipeline).

### Auto-merge

Turns on [GitHub auto-merge](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request) for each PR it opens or rebuilds. Configure with `enabled` (default `false`) and `mergeMethod` (`"squash"`, `"merge"`, or `"rebase"`; default `"squash"`).

```json
{ "autoMerge": { "enabled": true, "mergeMethod": "squash" } }
```

Two repository settings are required: **Allow auto-merge** under Settings > General > Pull Requests, and **required status checks** on the base branch (via ruleset or branch protection), which auto-merge waits for. The token needs `pull-requests: write` and `contents: write`.

**Safety:** auto-merge lands dependency changes with no human read. Pair it with `minReleaseAgeDays` (the action warns if `autoMerge` is on and the age is `0`), and note that PRs carrying human-authored content commits are skipped (merge commits, such as GitHub's "Update branch", are ignored).

## How It Works

1. **Discover** catalog definitions — `package.json` with a `catalog` field (Bun), `pnpm-workspace.yaml` (pnpm), `.yarnrc.yml` (Yarn) — including named catalogs
2. **Query** npm for the latest stable versions, applying ignore rules, semver classification, and minimum release age
3. **Group** updates into batches (unmatched packages get individual PRs)
4. **Audit** vulnerable transitive dependencies and open override PRs (bun/pnpm → `overrides`, yarn → `resolutions`)
5. **Sync** existing PRs — close stale ones, rebuild conflicting ones
6. **Create** new PRs (override PRs first for security priority), respecting `maxOpenPrs`

Each catalog location (a directory + definition file + catalog name) is processed independently, with its own branch namespace: `catalog-update/<directory>/<catalog-name>/<group>` for non-default catalogs. Each catalog PR includes a table of updated packages with version changes and GitHub Releases notes. Each override PR includes a summary table and collapsible advisory details. Edits to YAML definition files preserve comments and formatting.

## Contributing

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
