# Changelog

## [0.10.0](https://github.com/brandhaug/catalog-update-action/compare/catalog-update-action-v0.9.0...catalog-update-action-v0.10.0) (2026-04-09)


### Features

* add CI and automated release workflows  ([#2](https://github.com/brandhaug/catalog-update-action/issues/2)) ([8dcb113](https://github.com/brandhaug/catalog-update-action/commit/8dcb113f5351195daadcb5a9c24471d11aeb5cd9))
* add configurable token input and fetch remote refs before processing ([ccd1858](https://github.com/brandhaug/catalog-update-action/commit/ccd18588dd965a57fb0fa00285c6df9af19c9620))
* add JSON Schema for config validation and IDE autocomplete ([175110b](https://github.com/brandhaug/catalog-update-action/commit/175110b20f50e1671498fb3f4643296e03eaab10))
* add minReleaseAgeDays config for supply chain protection ([e7dd39c](https://github.com/brandhaug/catalog-update-action/commit/e7dd39c90d1bff847ec87106c10febc8d07a1eb3))
* add monorepo support with automatic catalog directory discovery ([de67f7e](https://github.com/brandhaug/catalog-update-action/commit/de67f7e6286aa0f0162cc708eed56693cbcc7af7))
* add prerelease version support ([04d3769](https://github.com/brandhaug/catalog-update-action/commit/04d376904414fb564e796db65a5ab83852d2e4a0))
* add release change type for prerelease-to-stable graduation ([227daec](https://github.com/brandhaug/catalog-update-action/commit/227daec728a972de71129e1abe89117e03e1f415))
* add vulnerability audit with transitive dependency overrides ([c1a8441](https://github.com/brandhaug/catalog-update-action/commit/c1a844104116c91c06928c3b55585a602a2b3203))
* make catalog-update-action a CLI tool ([747af53](https://github.com/brandhaug/catalog-update-action/commit/747af53acb1947487559c821c92dba9db941d18a))
* replace tsc with oxlint and oxfmt ([#6](https://github.com/brandhaug/catalog-update-action/issues/6)) ([4a77686](https://github.com/brandhaug/catalog-update-action/commit/4a7768626e13dfac68d0de249672adc4a6f0e3b3))
* scope override keys by vulnerable range for multi-range support ([8be60b4](https://github.com/brandhaug/catalog-update-action/commit/8be60b470ea510238f87b25bbf843944c9f46791))


### Bug Fixes

* clean up stale tool-generated overrides from package.json ([eea789f](https://github.com/brandhaug/catalog-update-action/commit/eea789f683797be2391893bc119d8ba116f554bb))
* configure git identity and GH_TOKEN in action ([4670916](https://github.com/brandhaug/catalog-update-action/commit/467091654d6ba5aa3db3890d37f90b0785cf81b3))
* delete lockfile before install for override branches ([be1bc0c](https://github.com/brandhaug/catalog-update-action/commit/be1bc0ce343b7adb9bf683c0457b38474151058c))
* improve error handling for PR creation failures ([a9947c7](https://github.com/brandhaug/catalog-update-action/commit/a9947c73e28b5dd0f0114a2a7658bb350b468e83))
* push version tag explicitly instead of using --follow-tags ([#5](https://github.com/brandhaug/catalog-update-action/issues/5)) ([b46ce76](https://github.com/brandhaug/catalog-update-action/commit/b46ce76666664deb066ce5bbaad3b32717fee669))
* remove hardcoded GITHUB_TOKEN, inherit from caller ([4bac3ac](https://github.com/brandhaug/catalog-update-action/commit/4bac3ac51a006938adb3941a534babfcb2b6d0b5))
* remove registry-url to allow npm OIDC trusted publishing ([#3](https://github.com/brandhaug/catalog-update-action/issues/3)) ([f44933a](https://github.com/brandhaug/catalog-update-action/commit/f44933ac645952bdc8d409d6d23c75305d476f57))
* store publish times for packages without GitHub repo URL ([902a0b2](https://github.com/brandhaug/catalog-update-action/commit/902a0b253b9e4fb27b819518f5b75d09cbbee6dd))
* update repo URLs to brandhaug/catalog-update-action ([6301eec](https://github.com/brandhaug/catalog-update-action/commit/6301eec6eb1461ea1202f55ed2cb8e9db71a1a63))
* use node 24 for npm trusted publishing OIDC support ([#4](https://github.com/brandhaug/catalog-update-action/issues/4)) ([fbdd02c](https://github.com/brandhaug/catalog-update-action/commit/fbdd02c1b23d714bdee666fbc42309f3ad489643))
