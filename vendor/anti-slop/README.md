# Anti-slop lint plugin

`plugin.mjs` and `license.md` are byte-for-byte copies of
`config/oxlint/anti-slop/` from the published `ultracite@7.10.6` package,
the version previously installed by this repository. The plugin originates at
<https://github.com/dmmulroy/anti-slop> and retains its bundled MIT license.

Only this self-contained plugin was used from Ultracite. Keeping the bundle here
removes the unused CLI's dependency on vulnerable `braces` without changing the
plugin or this repository's configured lint rules. Oxlint loads it from
`.oxlintrc.json`; formatter, linter, and Fallow exclusions preserve vendor bytes.

SHA-256:

```text
c35dbe5174f74ad5e502830560fd1cbd91cdb976bdd11b37c172d70c349c16e6  plugin.mjs
e17a21c4394616d58f587a3bf7b5cd3fec5da60cf91d88e5d42ac6e274c5b12b  license.md
```

To update, unpack a reviewed Ultracite release, copy both files from that
directory without modification, update the version and hashes here, and run
`bun run lint`, `bun test`, `bun run dead-code`, and `bun audit`.
