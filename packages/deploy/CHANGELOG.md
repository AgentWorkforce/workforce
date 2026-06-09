# Changelog

All notable changes to `@agentworkforce/deploy` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.52] - 2026-06-09

### Added

- **Drain paginated picker options (lockstep consumer for cloud#2018)** (#2018)
- **Phase 5 — installation-centric connect flow in CLI** (#217)

## [3.0.51] - 2026-06-08

### Added

- **Auto-inject ai-hist MCP + enforce trajectory recording**

### Changed

- Consolidate trajectories + ai-memory under memory (opt-in) (#210)

## [3.0.47] - 2026-06-04

### Added

- Allow listener-free agents only when marked `launchedBy: "team-dispatcher"`.

## [3.0.46] - 2026-06-04

### Fixed

- Stamp credentialSelections on oauth harness legs (#196) (#196)

## [3.0.45] - 2026-06-04

### Documentation

- Spec — `agentworkforce integrations` integration & trigger discoverability (CLI + mcp-workforce tool) (#191)

## [3.0.38] - 2026-06-01

### Added

- **Move triggers/schedules/watch to agent.ts (defineAgent)** (#175)

## [3.0.37] - 2026-06-01

### Added

- **Thread persona integrations through proxy mint** (#173)

## [3.0.36] - 2026-06-01

### Added

- **Wire runtime credentials into workforce deploy** (#171)

## [3.0.33] - 2026-05-29

### Fixed

- Reconcile canonical integration status (#165)

## [3.0.31] - 2026-05-28

### Added

- **Make sandbox a boolean field — skip boot with sandbox: false** (#159)

## [3.0.29] - 2026-05-28

### Fixed

- Detect workspace-scoped integration fallback (#157)

## [3.0.28] - 2026-05-28

### Changed

- Require ready integration status before deploy (#155)

## [3.0.27] - 2026-05-27

### Added

- **First-class select() on the terminal IO for pickers**
- **Onboarding pickers for picker-annotated inputs**

### Fixed

- Prepare subscription credentials before integrations (#152)

### Changed

- Address review: preserve picker values, fix paste parsing, warn on --no-prompt

## [3.0.26] - 2026-05-27

### Added

- Accept authored `persona.ts`/JS source modules anywhere deploy preflight accepts
  persona JSON, preserving sibling-file `import.meta.url` reads during evaluation.

## [3.0.25] - 2026-05-26

### Added

- **Add GitHub PR merge writeback client** (#148)

## [3.0.24] - 2026-05-26

### Changed

- Deploy/persona-kit: catch integration-provider + persona-tag footguns before the cloud rejects them (#141)

## [3.0.22] - 2026-05-24

### Dependencies

- Bump @daytonaio/sdk to ^0.179.0 (#134)

## [3.0.20] - 2026-05-23

### Added

- **Make harness/model/systemPrompt optional for handler personas** (#135)

## [3.0.19] - 2026-05-23

### Fixed

- Pass persona source.kind into connect-session + status poll (#133)

## [3.0.18] - 2026-05-22

### Fixed

- Accept pending/syncing/degraded as connected in preflight (#132)

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
