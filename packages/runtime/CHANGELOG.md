# Changelog

All notable changes to `@agentworkforce/runtime` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.47] - 2026-06-04

### Added

- Preserve `launchedBy: "team-dispatcher"` from `defineAgent(...)` exports.

## [3.0.46] - 2026-06-04

### Added

- **Codex backend LlmContext credential leg for ChatGPT subscription OAuth tokens** (#198)

## [3.0.44] - 2026-06-04

### Added

- **Env-derived LlmContext for cloud deployments** (#193)
- **Runs export + invoke --scaffold + envelope contract test vs cloud (#189)** (#189)

## [3.0.43] - 2026-06-04

### Added

- **Workforce invoke — fixture-replay simulation CLI (#186 P2)** (#186)
- **Invocation dry-run/simulation with Cloud-compatible run records (#186)** (#186)

## [3.0.42] - 2026-06-03

### Fixed

- Consume Linear triggers from adapter catalog (#181)

## [3.0.41] - 2026-06-02

### Added

- **Type Linear agent session events** (#180)

## [3.0.40] - 2026-06-02

### Changed

- Source the VFS transport from @relayfile/adapter-core (#179)

## [3.0.38] - 2026-06-01

### Added

- **Move triggers/schedules/watch to agent.ts (defineAgent)** (#175)

## [3.0.37] - 2026-06-01

### Added

- **Wire relaycast MCP into broker-launched personas** (#170)

## [3.0.32] - 2026-05-28

### Added

- **Add runtime credentials context** (#162)

## [3.0.31] - 2026-05-28

### Added

- **Make sandbox a boolean field — skip boot with sandbox: false** (#159)

## [3.0.25] - 2026-05-26

### Added

- **Add GitHub PR merge writeback client** (#148)

## [3.0.21] - 2026-05-23

### Added

- **Wire cloud workflow and integration runtime defaults** (#136)

## [3.0.20] - 2026-05-23

### Added

- **Make harness/model/systemPrompt optional for handler personas** (#135)

## [3.0.4] - 2026-05-13

### Changed

- Deploy v1 CLI runtime credentials and customer example (#109)
