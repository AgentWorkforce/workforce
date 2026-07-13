# Changelog

Cross-package release notes for AgentWorkforce. Package changelogs contain
package-level detail.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.1.15] - 2026-07-13

### Added

- `@agentworkforce/cli`: warm fast path for `agent <persona>`. Repeat
  launches of the same persona in the same repo reuse the previous session's
  sandbox mount plus a digest-validated launch plan, spawning the harness in
  tens of milliseconds; the mount reconciles with the repo in the background
  while the harness boots. Any change to the persona, its source dirs,
  skills, dotfiles, or relevant environment falls back to the full launch.
  Disable with `AGENTWORKFORCE_NO_FAST=1`. Launch-phase timings are printable
  with `AGENTWORKFORCE_PERF=1`.

### Changed

- `@agentworkforce/cli`: cold launches are an order of magnitude faster.
  Sandbox mounts populate from `git ls-files` (`@relayfile/local-mount`
  `population: 'auto'`), so gitignored trees never get mirrored or rescanned;
  autosync starts from population-seeded state instead of re-reading every
  file pair; the skill-cache mirror no longer copies the install-time npm
  cache into the mount; and cloud subcommand handlers load lazily off the
  launch path. In the relay repo, launch-to-harness went from ~26s to ~2.5s
  cold and ~20ms warm, and session teardown from ~11s to under 1s.
- `@agentworkforce/cli`: requires `@relayfile/local-mount` ^0.10.23
  (git-list population, `attachMount`, exported autosync state, and the
  external-teardown safety guard).

