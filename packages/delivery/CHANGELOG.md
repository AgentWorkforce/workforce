# Changelog

All notable changes to `@agentworkforce/delivery` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.1.24] - 2026-07-16

### Fixed

- Close composable runtime policy and contract gaps (#273)

## [4.1.23] - 2026-07-15

### Added

- **Close the composable local runtime loop** (#272)

## [4.1.18] - 2026-07-15

### Added

- **Add reusable cron and Slack delivery helpers** (#261)

## [4.1.17] - 2026-07-15

### Added

- Add reusable Slack roster loading, mention linking, roster formatting,
  channel-id validation, and strict writeback-receipt utilities.

### Changed

- Reuse the public `requireSlackReceipt` guard in blocking Slack delivery so an
  empty timestamp is always surfaced as a delivery failure.

## [4.1.14] - 2026-06-25

### Added

- **Add relaycast target** (#254)
