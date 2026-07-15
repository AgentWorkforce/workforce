Workforce composable runtime closure notes

- Extended `agentworkforce invoke` to support exactly one of `--fixture`, `--schedule`, or `--case`, plus `--reads`, `--model`, and rerun-only `--watch`.
- Routed local invoke through `RunRequestV1` / `RunRecordV2` using `packages/runtime/src/local-preview.ts`.
- Enforced preview isolation before bundle import by:
  - binding Relayfile preview transport before import and restoring it in `finally`
  - sanitizing process env to strip ambient credentials
  - installing a policy-controlled fetch bridge
  - denying authored raw imports of `node:http`, `node:https`, `node:net`, `node:tls`, `node:dgram`, and `node:child_process`
- Added deterministic preview coverage proving:
  - preview transport intercepts ambient Slack helper writes
  - allowed live GET reads can pass while denied POST writes do not reach the sentinel server
  - authored raw `node:https` import fails closed before handler execution
- Added versioned YAML case parsing for checked-in case shape, multi-turn state carry-forward, HN-oriented assertions, and HTTP fixtures.
- Added replay bundle export support to `runs export --bundle` and local replay ingestion that preserves replay mode, state-source fidelity labels, and source run provenance when present.
- Extended integrations JSON/detail output with `registrationHealth`.
- Added a parent-process watch rerun loop using local dependency tracking plus watched fixture/case/seed files.

Verification

- `pnpm --filter @agentworkforce/runtime test`
- `pnpm --filter @agentworkforce/deploy test`
- `pnpm --filter @agentworkforce/cli test`

Follow-up after `ee57866`

- Local preview now fails closed unless the parent runtime is a supported patched Node `>=26.3.1` with `--permission`, `--allow-fs-read`, and `--allow-net` support. The refusal message includes the detected Node version.
- Worker argv still omits `--allow-net`, so direct network access inside the worker remains denied even on the supported parent runtime.
- Added credential-shape redaction independent of input key names, applied before values enter worker env / invoke payloads and again on local preview logs and run records.
- Added bounded preview worker readiness / overall / fetch IPC timeouts, deterministic parent-fetch failure responses, AbortController-backed parent fetch cancellation, SIGTERM→SIGKILL teardown, and a timeout test that asserts no orphan `local-preview-worker-*` staging dirs remain.
- Replay ingestion now accepts Cloud's wrapped replay bundle shape (`{schemaVersion, manifest, files}`), unwraps `files["event.json"].content`, preserves run/event provenance from the manifest bundle, and keeps unavailable-vs-historical state fidelity instead of assuming a synthetic top-level event payload.
- Relevant CI / publish / verify / deploy-e2e workflows now pin Node `26.5.0` so invoke safety is exercised on the supported runtime rather than relying on a test-only local setup.

Verification (Node 26.5)

- `mise exec node@26.5.0 -- pnpm --filter @agentworkforce/runtime test`
- `mise exec node@26.5.0 -- pnpm --filter @agentworkforce/deploy test`
- `mise exec node@26.5.0 -- pnpm --filter @agentworkforce/cli test`
- `mise exec node@26.5.0 -- pnpm -r build`
