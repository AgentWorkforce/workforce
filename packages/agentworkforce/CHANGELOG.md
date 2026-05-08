# Changelog

All notable changes to `agentworkforce` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `agentworkforce agent` now records default Burn attribution tags through
  the CLI package; opt out with `--no-burn` or `AGENTWORKFORCE_BURN=0`.
- `agentworkforce create` now opens `persona-maker@best`, supports target
  selection, and passes `TARGET_DIR` / `CREATE_MODE` persona inputs.
- `agentworkforce --version` now prints the installed package version.

## [0.8.0] - 2026-05-07

### Added

- **Add persona create mode**

## [0.7.0] - 2026-05-07

### Fixed

- Add agentworkforce version flag

## [0.6.0] - 2026-05-06

### Added

- **Support installable persona sources**

### Dependencies

- Publish only agentworkforce bin
- Sync package versions to 0.5.3

## [0.4.0] - 2026-04-29

### Added

- Initial release. This package installs the same CLI as `@agentworkforce/cli`
  under the unscoped `agentworkforce` name, so `npm i -g agentworkforce`
  provides the `agentworkforce` command on your PATH.
