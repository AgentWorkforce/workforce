# Validation

- `pnpm install`: passed; lockfile unchanged because no published SDK release
  satisfies the required exports.
- `pnpm -r build`: passed.
- `pnpm run typecheck`: passed, including examples.
- `pnpm run lint`: passed.
- Persona mapper focused suite: 11 passed.
- Complete deploy suite after final fixes: 292 passed, 1 skipped (opt-in live
  Daytona smoke). Includes real UNIX-socket byte piping, attach timing,
  stop/detach, cleanup errors, and unchanged Node handler mint payload.
- Complete local-surface suite: 14 passed.
- Focused CLI/parser/dispatch/runtime-picker suites: 127 passed.
- The complete CLI suite under Node 22 also failed 30 existing invocation/
  permission tests plus the existing config-directory whitespace test; the Node
  26 root rerun stopped earlier in runtime, so it did not reach the full CLI suite.
- Root static tests include a package-wide no-agent-relay-shell scan and a
  non-vacuous matcher test. They pass.
- Initial `pnpm run test` under default Node 22.22.2 failed in 14 existing
  runtime local-preview tests, which require Node >=26.3.1. A supplemental
  rerun used the already-installed Node 26.8.2 with a command-local PATH
  override. Its release-workflow checks passed, but unchanged local-preview
  and broker-log tests also failed; the slower rerun was stopped after those
  failures were confirmed. The repository test gate is NOT green. The root
  agent-card E2E stage was not reached.
- Installed Relay `/fleet` import check: fails with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`, consistent with registry metadata for
  latest `@agent-relay/cloud@12.1.0` and `@agent-relay/sdk@12.1.0` lacking both
  required subpaths.
- `flows check ../flows/examples/agentworkforce-sandbox-session/wire-up.flow.ts`:
  failed with `REFUSED [invalid_spec] ... contains invalid YAML or JSON`.
- Veto diff review: `warn`; host-supplied specialist review identified the
  missing published SDK as a high-severity release dependency and unverified
  Cloud read-only enforcement as a medium-severity gate. No live secrets found.
  MCP sampling was unavailable; this was a host review submitted through Veto,
  not an independent agent review. No subagents were spawned.
- Final deploy typecheck includes the updated live-smoke credential gate.
- `git diff --check` and staged diff whitespace check: passed.

Live sandbox execution and Relay's 1630 readonly roundtrip have not run. No
production rollout, remote CI success, or PR creation is claimed. See
`impl/upstream-blockers.md` for the concrete remaining cross-repo requirements.
