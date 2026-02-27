# catalog-update-action

Automated dependency updates for Bun's `catalog:` protocol. Replaces Dependabot for monorepos using [Bun workspaces](https://bun.sh/docs/install/workspaces) with a centralized [catalog](https://bun.sh/docs/install/workspaces#versioning).

## Why

Dependabot doesn't understand Bun's `catalog:` protocol — it can't update the centralized version catalog in your root `package.json`. This action fills that gap by:

- Reading the `catalog` field from your root `package.json`
- Querying npm for the latest stable versions
- Grouping updates based on configurable patterns (similar to Dependabot groups)
- Creating and syncing PRs via the GitHub CLI
- Including release notes from GitHub Releases in PR descriptions

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

### CLI

```bash
# Full run (creates PRs)
bun src/main.ts

# Preview only
bun src/main.ts --dry-run

# Custom config path
bun src/main.ts --config path/to/.catalog-updaterc.json
```

## Configuration

Create a `.catalog-updaterc.json` in your repository root:

```json
{
  "branchPrefix": "catalog-update",
  "defaultBranch": "master",
  "maxOpenPrs": 20,
  "concurrency": 10,
  "packageManager": "bun",
  "groups": [
    { "name": "react", "patterns": ["react", "react-dom"] },
    { "name": "vite", "patterns": ["vite", "vitest", "@vitejs/*", "@vitest/*"] },
    { "name": "storybook", "patterns": ["@storybook/*", "storybook*"] },
    { "name": "all-patch-updates", "patterns": ["*"], "updateTypes": ["patch"] }
  ],
  "ignore": [
    { "pattern": "*storybook*", "updateTypes": ["major"] }
  ]
}
```

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `branchPrefix` | `string` | `"catalog-update"` | Prefix for PR branches (e.g., `catalog-update/react`) |
| `defaultBranch` | `string` | `"master"` | Base branch for PRs |
| `maxOpenPrs` | `number` | `20` | Maximum number of open PRs at any time |
| `concurrency` | `number` | `10` | Max concurrent npm registry requests |
| `packageManager` | `string` | `"bun"` | Package manager for lockfile updates (`bun`, `npm`, `pnpm`, `yarn`) |
| `groups` | `array` | `[]` | Dependency grouping rules (see below) |
| `ignore` | `array` | `[]` | Dependency ignore rules (see below) |

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

## How It Works

1. **Parse** — Reads the `catalog` field from root `package.json`, extracting package names and current versions (supports `^` ranges and `npm:` aliases)
2. **Query** — Fetches latest stable versions from the npm registry (skips pre-releases)
3. **Filter** — Applies ignore rules and classifies updates as major/minor/patch
4. **Group** — Assigns updates to configured groups; unmatched packages get individual PRs
5. **Sync** — For existing PRs: closes stale ones, rebuilds conflicting or outdated ones
6. **Create** — Creates new PRs for groups that don't have one yet, respecting the `maxOpenPrs` limit

Each PR includes:
- A table of all updated packages with version changes
- Release notes fetched from GitHub Releases (with intermediate version support for monorepos)

## Action Inputs

| Input | Default | Description |
| --- | --- | --- |
| `config` | `.catalog-updaterc.json` | Path to the config file |
| `dry-run` | `false` | Preview updates without creating PRs |

## Requirements

- [Bun](https://bun.sh) runtime
- `gh` CLI (pre-installed on GitHub Actions runners)
- `GITHUB_TOKEN` with `contents: write` and `pull-requests: write` permissions

## License

MIT
