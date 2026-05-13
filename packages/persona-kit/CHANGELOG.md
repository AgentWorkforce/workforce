# Changelog

All notable changes to `@agentworkforce/persona-kit` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.10] - 2026-05-13

### Fixed

- Defer @relayfile/local-mount import to call site (#121)

## [3.0.7] - 2026-05-13

### Fixed

- Tags optional + free-form per cloud#553 schema (#553)

## [3.0.3] - 2026-05-13

### Added

- **--mode cloud (OSS-generic persona+bundle POST)** (#102)

## [3.0.2] - 2026-05-13

### Added

- **JSON Schema export + fixture personas + lint codes** (#94)
- **Add IntegrationConfig.source discriminator** (#97)
- **Adopt Relayfile-VFS as the canonical integration-client style** (#92)
- **Add proactive-agent-builder persona + fix optional-input regression** (#87)

### Dependencies

- Cover new packages in publish.yml allow-list + fix mcp-workforce build (#104)

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

