# Changelog

All notable changes to `@agentworkforce/workload-router` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.4] - 2026-05-13

### Added

- **Mount/MCP/sidecar guidance via agentsMd sidecar** (#108)

## [3.0.2] - 2026-05-13

### Added

- **Add proactive-agent-builder persona + fix optional-input regression** (#87)

## [2.1.2] - 2026-05-11

### Changed

- Persona-kit: add local skill source provider

## [2.0.1] - 2026-05-11

### Changed

- Move persona-shape code from harness-kit + workload-router into persona-kit (#65)
- Delete @agentworkforce/harness-kit from the monorepo (#65)
- Shrink workload-router: drop persona-domain re-exports (1.0.0) (#68)

## [1.0.0] - 2026-05-11

### Changed (BREAKING)

- Drop all persona-domain re-exports that used to be forwarded from
  `@agentworkforce/persona-kit`. Consumers must now import persona constants,
  types, and functions (e.g. `HARNESS_VALUES`, `PERSONA_TIERS`,
  `PERSONA_TAGS`, `PERMISSION_MODES`, `Harness`, `PersonaSpec`,
  `PersonaSelection`, `PersonaSkill`, `materializeSkills`,
  `parsePersonaSpec`, …) directly from `@agentworkforce/persona-kit`.
- The remaining public surface is routing-only: `RoutingProfile`,
  `RoutingProfileRule`, `RoutingProfileId`, `personaCatalog`,
  `listBuiltInPersonas`, `routingProfiles`, `resolvePersona`,
  `resolvePersonaByTier`, `usePersona`, `useSelection`, and the evidence /
  owner-decision exports from `./eval`.

## [0.19.0] - 2026-05-08

### Changed

- Address PR feedback on auto-improve flow
- Offer auto-improve persona prompt at session end

## [0.18.0] - 2026-05-08

### Changed

- Move session root to ~/.agentworkforce/workforce/sessions

## [0.17.0] - 2026-05-08

### Added

- **Add optional defaultTier to PersonaSpec**

## [0.16.0] - 2026-05-08

### Added

- **Add --dry-run flag to agentworkforce agent**

## [0.15.1] - 2026-05-08

### Added

- Personas can declare prompt-visible runtime `inputs`, which are parsed,
  validated, and propagated through resolved selections.

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

## [0.10.0] - 2026-05-08

### Released

- v0.10.0

## [0.8.0] - 2026-05-07

### Added

- **Add persona create mode**

## [0.6.1] - 2026-05-06

### Fixed

- Require PR shipping in relay workflow persona
- Update agent relay workflow persona expectations

## [0.6.0] - 2026-05-06

### Released

- v0.6.0

## [0.5.4] - 2026-05-02

### Dependencies

- Sync package versions to 0.5.4

## [0.5.1] - 2026-04-30

### Added

- **Wire up new persona with headless orchestrator skill**
- **Add npm-package-bundler-guard persona**

### Fixed

- Address remaining PR feedback
- Update schema.json with all intents, add npm-package-compat test, fix CI

## [0.4.1] - 2026-04-29

### Released

- v0.4.1
