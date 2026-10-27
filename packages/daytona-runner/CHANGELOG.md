# Changelog

All notable changes to `@agentworkforce/daytona-runner` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.1.51] - 2026-08-31

### Changed

- Peer dependency moved from the deprecated `@daytonaio/sdk` to `@daytona/sdk`
  (same API, no breaking changes upstream) and widened to `>=0.185.0`.
  Consumers install `@daytona/sdk` instead.

## [4.1.50] - 2026-08-24

### Released

- v4.1.50

## [4.1.41] - 2026-08-14

### Released

- v4.1.41

## [4.1.18] - 2026-07-15

### Added

- **Add reusable cron and Slack delivery helpers** (#261)

## [4.0.2] - 2026-06-11

### Fixed

- Patch vulnerable transitive deps (shell-quote, protobufjs, hono) and align adapter-core

## [3.0.31] - 2026-05-28

### Released

- v3.0.31

## [3.0.22] - 2026-05-24

### Dependencies

- Bump @daytonaio/sdk to ^0.179.0 (#134)

