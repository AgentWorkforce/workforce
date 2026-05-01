# Changelog

All notable changes to `@agentworkforce/cli` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

