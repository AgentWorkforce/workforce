# Changelog

All notable changes to `@agentworkforce/deploy` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.17] - 2026-05-22

### Fixed

- Scope-aware + configKey-aware integration preflight (#131)

## [3.0.16] - 2026-05-22

### Added

- **Cloud mode + relayfile watch personas (spec 03)** (#130)

## [3.0.10] - 2026-05-13

### Fixed

- Existing-persona lookup uses /deployments list (not phantom /agents) (#120)

## [3.0.9] - 2026-05-13

### Fixed

- Point harness probe at /api/v1/cloud-agents (M3) (#119)
- Orchestrator + list/destroy read active.json; sanitize HTML errors (#118)

## [3.0.8] - 2026-05-13

### Fixed

- Prompt cloud login on integration auth failure (#116)
- Canonicalize cloud URL and rewrite agent-relay error hints (#117)

## [3.0.7] - 2026-05-13

### Fixed

- Tags optional + free-form per cloud#553 schema (#553)
- Cover integration connect preflight (#110)

### Changed

- Fail fast on deploy integration auth errors (#115)

## [3.0.6] - 2026-05-13

### Fixed

- Reuse @agent-relay/cloud auth as Bearer; drop workspace-token mint (#113)

## [3.0.4] - 2026-05-13

### Changed

- Deploy v1 CLI runtime credentials and customer example (#109)

## [3.0.3] - 2026-05-13

### Added

- **--mode cloud (OSS-generic persona+bundle POST)** (#102)

