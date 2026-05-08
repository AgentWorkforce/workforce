# Changelog

All notable changes to `@agentworkforce/cli` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
