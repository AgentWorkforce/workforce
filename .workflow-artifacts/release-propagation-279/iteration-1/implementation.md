# Implementation: workforce #279

## Outcome

- `bundleStager` requests an esbuild metafile and derives the manifest from the
  inputs that contributed bytes to `agent.bundle.mjs`, rather than from declared
  dependencies.
- The generated `package.json` retains the exact `@agentworkforce/runtime` pin
  and adds a versioned, deterministic `bundleManifest` containing only package
  names and exact versions.
- Manifest entries are deduplicated by the full `(name, version)` pair and
  sorted by name then version, so two installed versions of the same package
  remain visible.
- Package ownership follows real paths, covering workspace and pnpm symlinks.
  A bundled dependency with missing, malformed, or versionless package metadata
  fails staging with a path-free error instead of producing an incomplete
  manifest.
- The generated runner reads that same manifest from `package.json`, passes it
  unchanged to `startRunner`, and the runtime emits it in structured
  `runner.started` evidence.
- Existing cloud and sandbox transports already carry `package.json`; regression
  assertions now prove the manifest survives both the hosted bundle request and
  the sandbox file upload without a second source of truth.
- No secret, absolute path, pnpm store path, or other machine-specific locator is
  serialized into the manifest.

## Changed files

- `README.md` — documents the operator-queryable artifact and runtime signal.
- `packages/deploy/CHANGELOG.md` — records the deploy artifact change.
- `packages/deploy/src/bundle.ts` — derives, writes, and wires the exact bundle
  manifest while preserving the runtime pin.
- `packages/deploy/src/bundle.test.ts` — real esbuild/staging regressions for
  actual inputs, deterministic ordering, duplicate package versions,
  workspace/pnpm symlinks, absent metadata, runtime pin preservation, and path
  redaction.
- `packages/deploy/src/modes/cloud.test.ts` — proves the hosted deployment JSON
  carries the manifest unchanged.
- `packages/deploy/src/modes/sandbox-client.test.ts` — proves sandbox upload
  carries the manifest unchanged.
- `packages/runtime/CHANGELOG.md` — records the startup evidence change.
- `packages/runtime/src/runner.ts` — adds the typed manifest input and emits it
  on `runner.started`.
- `packages/runtime/src/runner.test.ts` — asserts exact structured startup
  evidence.
- `.workflow-artifacts/release-propagation-279/iteration-1/preflight.md` — input
  contract supplied for this iteration.
- `.workflow-artifacts/release-propagation-279/iteration-1/implementation.md` —
  this implementation and verification record.

## Red-first evidence

After lockfile installation and prerequisite workspace builds, these commands
failed on the new regressions before implementation:

```bash
pnpm --filter @agentworkforce/runtime test
```

- Expected red: TypeScript rejected the new `bundleManifest` runner option.

```bash
pnpm --filter @agentworkforce/deploy test
```

- Expected red: the generated runner did not read/pass the manifest and the
  staged `package.json` had no `bundleManifest`.

## Verification commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @agentworkforce/events build
pnpm --filter @agentworkforce/persona-kit build
pnpm --filter @agentworkforce/deploy test
node --test packages/runtime/dist/runner.test.js
node --test packages/runtime/dist/clients/index.test.js packages/runtime/dist/cloud-defaults.test.js packages/runtime/dist/cloud-llm.test.js packages/runtime/dist/cron.test.js packages/runtime/dist/ctx.test.js packages/runtime/dist/define-agent.test.js packages/runtime/dist/harness-process.test.js packages/runtime/dist/proactive.test.js packages/runtime/dist/relay-mcp.test.js packages/runtime/dist/relay.test.js packages/runtime/dist/run-contracts.test.js packages/runtime/dist/runner.test.js packages/runtime/dist/shim.contract.test.js packages/runtime/dist/shim.test.js packages/runtime/dist/simulate/simulate.test.js packages/runtime/dist/to-agent-event.test.js packages/runtime/dist/trajectory.test.js
pnpm run build
pnpm run lint
pnpm run typecheck
git diff --check
```

Results:

- Deploy package suite: 230 passed, 0 failed.
- Runtime runner suite: 13 passed, 0 failed.
- All runtime suites executable on this host, excluding the unrelated
  permission-boundary file: 120 passed, 0 failed.
- Workspace build: passed.
- Workspace lint: passed.
- Workspace typecheck, including examples: passed.
- Diff whitespace validation: passed.

The unfiltered runtime command was also run:

```bash
pnpm --filter @agentworkforce/runtime test
```

It compiled successfully and reported 121 passing tests plus 13 failures, all
in `local-preview.test.js`. Those tests explicitly require the patched Node
permission API at Node >=26.3.1; this worktree host is Node 25.8.1. No failing
test touched bundle manifest or runner behavior.

## Real installed graph probe

The built stager was also exercised against the repository's real
`@agentworkforce/delivery` source graph. It produced this path-free manifest,
confirming resolution through installed pnpm inputs rather than fixture
declarations:

```json
{"schemaVersion":1,"packages":[{"name":"@relayfile/adapter-core","version":"0.5.6"},{"name":"@relayfile/adapter-linear","version":"0.4.6"},{"name":"@relayfile/relay-helpers","version":"0.4.7"},{"name":"@relayfile/sdk","version":"0.7.40"}]}
```

## Safety

- No merge, publish, release, deployment, production mutation, or rollback was
  performed.
- External writes are limited to the issue branch push and draft PR described
  below after all local gates are green.

## Remaining limitation

This repository can guarantee the staged/package artifact, sandbox upload,
hosted deploy request, and runtime startup log. Fleet-wide querying through
`deployments list --json` additionally requires the cloud service to persist and
return `bundle.packageJson.bundleManifest`; that optional cross-repository API
work is not claimed by this iteration.

## Delivery

- Branch: `codex/issue-279-bundle-versions`
- Implementation commit: `790ee7b` (`feat(deploy): record bundled package versions`)
- Draft PR: https://github.com/AgentWorkforce/workforce/pull/280
