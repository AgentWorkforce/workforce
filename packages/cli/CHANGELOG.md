# Changelog

All notable changes to `@agentworkforce/cli` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.1.19] - 2026-07-15

### Added

- **Fleet-node bridge for running proactive personas on a laptop** (#263)

## [4.1.18] - 2026-07-15

### Added

- **Add reusable cron and Slack delivery helpers** (#261)

## [4.1.15] - 2026-07-13

### Added

- **Warm fast path spawns the harness in ~20ms; 10x faster cold launches**

### Fixed

- Split PATH on the platform delimiter in resolveBinOnPath
- Harden the warm fast path per review
- Resolve fast-session exit even when the child exits during module load

### Dependencies

- Consume published @relayfile/local-mount 0.10.23

## [4.1.13] - 2026-06-25

### Added

- **Add managed harness source alias** (#257)

## [4.1.8] - 2026-06-21

### Fixed

- Explain trigger auth source on 403

## [4.1.7] - 2026-06-21

### Added

- **Add deployed persona trigger command**

## [4.0.5] - 2026-06-14

### Fixed

- Let --reconnect refresh a revoked harness LLM credential (#235)

## [4.0.4] - 2026-06-14

### Changed

- Unify workforce cloud auth session (#234)

## [4.0.2] - 2026-06-11

### Added

- **Add linear-dispatcher and repo-router persona packs** (#223)

### Fixed

- Resolve local skill sources against the persona JSON directory (#226)

## [4.0.0] - 2026-06-10

### Breaking Changes

- **Relay SDK AgentEvent + declarative relay persona field (Stage 1, A, B, C-runtime)** (#220)

## [3.0.51] - 2026-06-08

### Added

- **Auto-inject ai-hist MCP + enforce trajectory recording**
- **Add grok harness support**

### Fixed

- Use broker-aware agent-relay MCP for local persona spawns (#214)
- Route launch-metadata warnings to a log file
- Address grok harness review feedback

### Changed

- Consolidate trajectories + ai-memory under memory (opt-in) (#210)

### Dependencies

- Apply pr-reviewer fixes for #206 (#206)

## [3.0.45] - 2026-06-04

### Documentation

- Spec — `agentworkforce integrations` integration & trigger discoverability (CLI + mcp-workforce tool) (#191)

## [3.0.44] - 2026-06-04

### Added

- **Runs export + invoke --scaffold + envelope contract test vs cloud (#189)** (#189)

## [3.0.43] - 2026-06-04

### Added

- **Workforce invoke — fixture-replay simulation CLI (#186 P2)** (#186)

## [3.0.38] - 2026-06-01

### Added

- **Move triggers/schedules/watch to agent.ts (defineAgent)** (#175)

## [3.0.37] - 2026-06-01

### Added

- **Wire relaycast MCP into broker-launched personas** (#170)

## [3.0.31] - 2026-05-28

### Released

- v3.0.31

## [3.0.29] - 2026-05-28

### Changed

- Cli: default deploy mode to cloud (#158)

## [3.0.28] - 2026-05-28

### Changed

- Require ready integration status before deploy (#155)

## [3.0.26] - 2026-05-27

### Fixed

- `agentworkforce persona compile` now evaluates typed persona modules beside
  their source file, so `import.meta.url` sibling-file reads behave correctly.
- `agentworkforce deploy` now accepts authored persona source modules in
  addition to prebuilt JSON, and the CLI ships current trigger lint data for
  Slack `message.created` plus the `google-mail` deploy provider id.

## [3.0.23] - 2026-05-26

### Changed

- Vendor Relayfile trigger catalog in persona-kit (#139)

## [3.0.20] - 2026-05-23

### Added

- **Make harness/model/systemPrompt optional for handler personas** (#135)

## [3.0.15] - 2026-05-20

### Changed

- Bump @relayfile/local-mount 0.7.19 → 0.7.24 and include mount setup timing/file-count metrics in the sandbox ready line when available.

## [3.0.14] - 2026-05-20

### Added

- **Persistent skill cache to skip prpm install on repeat launches** (#124)

## [3.0.13] - 2026-05-19

### Changed

- Improve deployment list and logs CLI (#126)

## [3.0.12] - 2026-05-18

### Fixed

- Preserve dangerouslyBypassApprovalsAndSandbox on standalone personas (#125)

## [3.0.11] - 2026-05-14

### Dependencies

- Bump @relayfile/local-mount 0.7.0 → 0.7.19

## [3.0.9] - 2026-05-13

### Fixed

- Orchestrator + list/destroy read active.json; sanitize HTML errors (#118)

## [3.0.8] - 2026-05-13

### Fixed

- Prompt cloud login on integration auth failure (#116)
- Canonicalize cloud URL and rewrite agent-relay error hints (#117)

## [3.0.7] - 2026-05-13

### Fixed

- Tags optional + free-form per cloud#553 schema (#553)

## [3.0.6] - 2026-05-13

### Fixed

- Reuse @agent-relay/cloud auth as Bearer; drop workspace-token mint (#113)

## [3.0.5] - 2026-05-13

### Changed

- Preserve relay cloud login on workforce logout (#111)

## [3.0.4] - 2026-05-13

### Added

- **Add destroy command for tearing down deployed agents** (#107)

### Changed

- Deploy v1 CLI runtime credentials and customer example (#109)

## [3.0.3] - 2026-05-13

### Added

- **--mode cloud (OSS-generic persona+bundle POST)** (#102)

### Fixed

- Use the real binary name (agentworkforce) in help text, add deploy + login to Commands (#106)

## [3.0.2] - 2026-05-13

### Added

- **Support deploy input overrides** (#101)
- **Add proactive-agent-builder persona + fix optional-input regression** (#87)

## [2.1.3] - 2026-05-11

### Added

- **Translate codex mcpServers into --config args**

## [2.1.2] - 2026-05-11

### Changed

- Persona sources: keep cwd label as `cwd` (not `repo`)
- Persona sources: rename display labels (built-in / repo / personal)
- Persona-kit: add local skill source provider

## [2.1.0] - 2026-05-11

### Changed

- Persona-tui: address review feedback
- Cli: open interactive persona picker on bare invocation

## [2.0.1] - 2026-05-11

### Changed

- Migrate workforce CLI to consume persona-kit directly (#67)
- Move persona-shape code from harness-kit + workload-router into persona-kit (#65)
- Delete @agentworkforce/harness-kit from the monorepo (#65)
- Shrink workload-router: drop persona-domain re-exports (1.0.0) (#68)
- RunPersonaImprover: restore config files in try/finally
- RunPersonaImprover: escalate to SIGKILL after SIGTERM grace

## [0.19.0] - 2026-05-08

### Changed

- Address PR feedback on auto-improve flow
- Handle Ctrl-C during sandbox mount setup
- Make CLI launch spinners actually animate (#104)
- Offer auto-improve persona prompt at session end

## [0.18.0] - 2026-05-08

### Changed

- Move session root to ~/.agentworkforce/workforce/sessions

## [0.17.1] - 2026-05-08

### Changed

- Address review feedback on CLI launch spinner PR
- Show spinners during persona session install and exit sync

## [0.17.0] - 2026-05-08

### Added

- **Add optional defaultTier to PersonaSpec**

### Changed

- Agent: consult routingProfiles before defaultTier on no-@<tier>

## [0.16.0] - 2026-05-08

### Added

- **Add --dry-run flag to agentworkforce agent**

## [0.15.1] - 2026-05-08

### Added

- `agentworkforce agent` now records launch metadata for direct harness
  launches; opt out with `--no-launch-metadata` or
  `AGENTWORKFORCE_LAUNCH_METADATA=0`.
- `agentworkforce create` now opens `persona-maker@best`, supports
  `--save-in-directory=<target>` and `--save-default`, and passes
  `TARGET_DIR` / `CREATE_MODE` persona inputs.
- Persona source config supports `defaultCreateTarget` for the implicit create target.
- `--version`/`-v` now prints the CLI package version.

### Changed

- `agentworkforce create` now defaults to writing into
  `<cwd>/.agentworkforce/workforce/personas` unconditionally, creating the
  directory if it does not already exist. The previous behavior fell back to
  the user persona dir when no cwd-local workforce existed; pass
  `--save-in-directory=<target>` (or set `defaultCreateTarget` in the source
  config) to author somewhere else.
- The previous `--to <target>` flag has been renamed to
  `--save-in-directory=<target>` (also accepted as
  `--save-in-directory <target>`). The old name is no longer recognized.

## [0.15.0] - 2026-05-08

### Released

- v0.15.0

## [0.14.0] - 2026-05-08

### Released

- v0.14.0

## [0.13.0] - 2026-05-08

### Released

- v0.13.0

## [0.12.0] - 2026-05-08

### Released

- v0.12.0

## [0.11.0] - 2026-05-08

### Released

- v0.11.0

## [0.10.0] - 2026-05-08

### Released

- v0.10.0

## [0.8.0] - 2026-05-07

### Added

- **Add persona create mode**

### Fixed

- Preserve standalone persona inputs

## [0.7.0] - 2026-05-07

### Added

- **Add persona pack install command**

### Fixed

- Disable scripts during persona package pack
- Add agentworkforce version flag
- Address persona install review feedback
- Expand Windows home persona install paths

## [0.6.0] - 2026-05-06

### Added

- **Support installable persona sources**

### Fixed

- Isolate cwd personas under personas dir
- Honor source config with legacy persona dir

### Dependencies

- Inline command name in help
- Use fixed command name in help
- Publish only agentworkforce bin

## [0.5.4] - 2026-05-01

### Added

- **Default claude/opencode to sandbox mount with git included**

## [0.5.3] - 2026-04-30

### Released

- v0.5.3

## [0.5.0] - 2026-04-29

### Released

- v0.5.0

## [0.3.0] - 2026-04-23

### Added

- **Opencode interactive sessions** — launch opencode as an alternative runtime alongside Claude Code, with full mount/sync parity and agent abstraction (#20, #23)
- **Persona maker** — create and edit personas from the CLI (#22)
- **Animated sync spinner** on the SIGINT exit path — 1st Ctrl-C starts an ora spinner with "Syncing… (Ctrl-C again to skip)", 2nd Ctrl-C aborts, 3rd force-exits (#24)

### Fixed

- Opencode agent now defaults to `permission: 'allow'` so it can actually edit files
- `configFiles` written by `onBeforeLaunch` are hidden from the mount-mirror in both directions — prevents masking a user's existing `opencode.json` on the way in and polluting the working tree on the way out (#23)
- Sync-exit line no longer misreports direction: "Synced N change(s) back to the repo" → "N file event(s) during session", since `onAfterSync`'s count is bidirectional and includes inbound initial-mirror events (#24)

### Changed

- Safe-path validation on persona `configFiles` materialization — rejects empty, absolute, and `..`-traversal paths so a malformed persona can't escape the mount (#23)
- Exhaustiveness guard in `buildInteractiveSpec` so future `Harness` union additions fail at compile time rather than silently at runtime (#23)
