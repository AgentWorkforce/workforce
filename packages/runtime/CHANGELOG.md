# Changelog

All notable changes to `@agentworkforce/runtime` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.1.29] - 2026-07-17

### Added

- Include the deployed bundle package manifest in structured `runner.started`
  evidence (#279).
- Add the reserved `[[NO_REPLY]]` harness contract for successful silent runs,
  including marker leak sanitization and observability.

## [4.1.26] - 2026-07-16

### Fixed

- Preserve trigger paths (#276)

## [4.1.25] - 2026-07-16

### Fixed

- Deliver one-shot Claude, Codex, and OpenCode prompts through stdin and Grok
  prompts through a private temporary file instead of oversized argv elements.

## [4.1.24] - 2026-07-16

### Fixed

- Close composable runtime policy and contract gaps (#273)

## [4.1.23] - 2026-07-15

### Added

- **Close the composable local runtime loop** (#272)

## [4.1.19] - 2026-07-15

### Added

- **Compile single-file Agent presets** (#267)
- **Add versioned Run contracts** (#266)
- **Add canonical Event contracts** (#265)

## [4.1.18] - 2026-07-15

### Added

- **Add reusable cron and Slack delivery helpers** (#261)

### Fixed

- Bump @relayfile/adapter-core to pick up telegram trigger catalog (#264)

## [4.1.17] - 2026-07-15

### Added

- Add `normalizeCronFire` and `workforceEventType` so handlers can consume one
  stable cron view across legacy v3 and normalized v4 runtime events.

## [4.1.16] - 2026-07-14

### Fixed

- Fix broker precedence for relay MCP injection (#260)

## [4.1.14] - 2026-06-25

### Added

- **Ctx.relay — agent-to-agent messaging over the relay (#254 pt.2)** (#254)

## [4.1.6] - 2026-06-18

### Fixed

- Treat Relayfile writebacks that time out without receipts as first-class `WritebackError`s from the runtime client helpers.

## [4.1.5] - 2026-06-18

### Dependencies

- Refresh relayfile trigger catalog

## [4.1.3] - 2026-06-16

### Added

- **Add OpenRouter/opencode LLM provider support**

### Changed

- Opencode is its own provider, not an alias for openrouter

## [4.1.1] - 2026-06-16

### Fixed

- Surface harness stderr on non-zero exit so failures aren't blank

## [4.0.4] - 2026-06-14

### Dependencies

- Refresh relayfile trigger catalog for daytona (#231)

## [4.0.2] - 2026-06-11

### Fixed

- Patch vulnerable transitive deps (shell-quote, protobufjs, hono) and align adapter-core

## [4.0.1] - 2026-06-10

### Fixed

- No-trigger personas narrow to AgentEvent, not BaseAgentEvent (#221)

## [4.0.0] - 2026-06-10

### Breaking Changes

- **Relay SDK AgentEvent + declarative relay persona field (Stage 1, A, B, C-runtime)** (#220)

## [3.0.51] - 2026-06-08

### Added

- **Auto-record decision trajectories + emit ai-hist contract (Workstream B)** (#207)

### Fixed

- Use broker-aware agent-relay MCP for local persona spawns (#214)
- Address grok harness review feedback

### Changed

- Consolidate trajectories + ai-memory under memory (opt-in) (#210)

## [3.0.50] - 2026-06-06

### Fixed

- Wire Relay MCP into cloud personas (#205)

## [3.0.49] - 2026-06-05

### Fixed

- Preserve cloud base path for memory (#203)

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
