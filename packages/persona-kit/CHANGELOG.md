# Changelog

All notable changes to `@agentworkforce/persona-kit` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.1.5] - 2026-06-18

### Dependencies

- Refresh relayfile trigger catalog

## [4.1.2] - 2026-06-16

### Added

- **Type gitlab materialization config**
- **Add adapter config passthrough**

## [4.1.0] - 2026-06-15

### Added

- **Add side-effect-free ./spec validation entrypoint**

## [4.0.4] - 2026-06-14

### Changed

- Preserve trigger maxConcurrency in persona-kit (#230)

### Dependencies

- Refresh relayfile trigger catalog for daytona (#231)

## [4.0.0] - 2026-06-10

### Breaking Changes

- **Relay SDK AgentEvent + declarative relay persona field (Stage 1, A, B, C-runtime)** (#220)

## [3.0.51] - 2026-06-08

### Added

- **Launch ai-hist via plain npx -y ai-hist-mcp + enable trajectory memory on persona-maker** (#211)
- **Auto-inject ai-hist MCP + enforce trajectory recording**
- **Add grok harness support**

### Fixed

- Launch full ai-hist MCP via npx -p ai-hist (revert bundled WHY-only server) (#209)
- Address grok harness review feedback

### Changed

- Consolidate trajectories + ai-memory under memory (opt-in) (#210)

### Dependencies

- Apply pr-reviewer fixes for #206 (#206)

## [3.0.47] - 2026-06-04

### Added

- Add `launchedBy: "team-dispatcher"` to `AgentSpec` for dispatcher-launched team members.

## [3.0.42] - 2026-06-03

### Fixed

- Preserve declared capabilities (#183)
- Consume Linear triggers from adapter catalog (#181)

## [3.0.41] - 2026-06-02

### Added

- **Type Linear agent session events** (#180)

## [3.0.39] - 2026-06-01

### Added

- **Typed per-provider integration scope keys** (#176)

## [3.0.38] - 2026-06-01

### Added

- **Move triggers/schedules/watch to agent.ts (defineAgent)** (#175)

## [3.0.37] - 2026-06-01

### Added

- **Wire relaycast MCP into broker-launched personas** (#170)

### Fixed

- Omit unsupported claude name flag (#174)

## [3.0.35] - 2026-05-31

### Added

- **Add typed ProactiveCapabilities to PersonaSpec (#1555 PR-B source-of-truth)** (#1555)

## [3.0.34] - 2026-05-31

### Added

- Add typed proactive capabilities to `PersonaSpec`.

## [3.0.33] - 2026-05-29

### Fixed

- Warn and skip approvalPolicy on codex 0.1.77+ (#167)

## [3.0.31] - 2026-05-28

### Added

- **Make sandbox a boolean field — skip boot with sandbox: false** (#159)

## [3.0.29] - 2026-05-28

### Fixed

- Detect workspace-scoped integration fallback (#157)

## [3.0.27] - 2026-05-27

### Added

- **Add picker annotation to PersonaInputSpec**

## [3.0.26] - 2026-05-27

### Fixed

- Align trigger lint with deploy provider ids by accepting `google-mail` as the
  Gmail trigger catalog alias, and cover Slack `message.created` as a canonical
  Slack trigger.

## [3.0.25] - 2026-05-26

### Dependencies

- Bump @relayfile/adapter-core ^0.3.13 → ^0.3.17 (#144)

## [3.0.24] - 2026-05-26

### Changed

- Deploy/persona-kit: catch integration-provider + persona-tag footguns before the cloud rejects them (#141)

## [3.0.23] - 2026-05-26

### Changed

- Vendor Relayfile trigger catalog in persona-kit (#139)

## [3.0.20] - 2026-05-23

### Added

- **Make harness/model/systemPrompt optional for handler personas** (#135)

## [3.0.16] - 2026-05-22

### Added

- **Cloud mode + relayfile watch personas (spec 03)** (#130)

## [3.0.15] - 2026-05-20

### Dependencies

- Bump @relayfile/local-mount 0.7.19 → 0.7.24.

## [3.0.14] - 2026-05-20

### Added

- **Persistent skill cache to skip prpm install on repeat launches** (#124)

## [3.0.11] - 2026-05-14

### Dependencies

- Bump @relayfile/local-mount 0.7.0 → 0.7.19

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
