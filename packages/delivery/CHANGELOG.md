# Changelog

All notable changes to `@agentworkforce/delivery` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add normalized Slack reaction parsing and reusable approval-card utilities
  that bind bounded hidden action ids to an exact app-authored message,
  approver, and emoji.

## [4.1.41] - 2026-08-14

### Released

- v4.1.41

## [4.1.39] - 2026-08-11

### Added

- **Add Slack inbound message helpers to delivery/src/slack.ts**

## [4.1.37] - 2026-07-25

### Added

- Add normalized Telegram inbound-message helpers, private owner-chat guards,
  line-aware chunking, and receipt-required multi-chunk delivery.
- Add a managed Cloud Telegram transport and make `createDelivery()` prefer it
  over Relayfile writeback when Cloud credentials are available.

## [4.1.33] - 2026-07-18

### Fixed

- Isolate Relaycast agent auth (#293)

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
