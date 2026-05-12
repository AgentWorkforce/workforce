# Changelog

All notable changes to `@agentworkforce/persona-kit` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.0] - 2026-05-12

### Added

- **Ship workforce deploy v1 — persona-as-deployable-agent**

### Fixed

- Address CI failure + persona-maker AGENTS.md drift
- Address PR review feedback + unblock examples typecheck

### Changed

- Drop tiers; flatten harness/model/prompt to top-level

## [2.1.4] - 2026-05-11

### Added

- **Add dangerouslyBypassApprovalsAndSandbox HarnessSettings**

### Fixed

- Tighten dangerouslyBypass field handling per PR review (#86)

### Reliability

- Cover explicit `false` happy-path for bypass field (#86)

## [2.1.3] - 2026-05-11

### Added

- **Translate codex mcpServers into --config args**

### Fixed

- Quote codex MCP TOML key segments

## [2.1.2] - 2026-05-11

### Changed

- Persona-kit: add local skill source provider

