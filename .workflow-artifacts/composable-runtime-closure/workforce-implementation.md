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
