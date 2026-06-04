# Lead Plan — `agentworkforce integrations` discoverability (CLI + mcp-workforce)

Source spec: `.workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/normalized-spec.md`
Acceptance contract: `.workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/acceptance-contract.json`
Pattern: `pipeline` (P1 → P2 → P3, P3 depends only on P1). Review depth: `deep` (dual reviewer fix-signoff loop).
Risk: high. Execution preference: local (Agent Relay).

## Non-goals

Carried verbatim from `non-goals.md` / spec §11. These constraints are guardrails; any change that touches them must be rejected by review.

- A `--scope` filter, caching, and connected-first sorting (all deferred; see spec §7). Do not add a `--scope` flag, in-memory or on-disk caching, or sort-by-connected ordering anywhere in P1/P2/P3.
- Trigger **payload** shapes — that belongs to the sibling track (#189 / cloud#1841). This spec only enumerates *which* events are subscribable; do not emit payload schemas, examples, or envelope hints in the CLI table, single-provider view, `--json` document, or MCP tool output.
- Connect/disconnect actions from this command — `deploy` owns the connect flow. `integrations-list.ts`, the `integrations` CLI command, and `list_integrations` MCP tool are strictly read-only. No catalog writes, no OAuth kickoff, no `connect`-style side effects.

Additional non-goals derived from the settled decisions (spec §7) — treat these as scope guardrails for the implementation:

- Do **not** reach `@relayfile/sdk` directly. All catalog / connection data flows through cloud's API via `CloudApiClient` (spec §4).
- Do **not** call `process.exit()` from any new code; set `process.exitCode` instead (spec §7.12).
- Do **not** leak `configKey`, OAuth tokens, or session URLs in any output (spec §7.9). Even when present in upstream payloads, strip them before emission.
- Do **not** restructure persona-kit, `lintTriggers`, or autocomplete types — those faces already exist and are out of scope (spec §2 table; persona-kit stays presentation-free per §7.10).
- Do **not** introduce a `integrations list` / `integrations status` nested subcommand split (spec §7.1).

## Routing contract

Routing decisions from `acceptance-contract.json.routingContract`, plus the runtime-vs-generation skill boundary in `skill-application-boundary.json`.

- **Local execution**: this workflow runs through Agent Relay against the generated workflow artifact. The pipeline is three sequential PR slices (P1 deploy core → P2 CLI presenter → P3 MCP tool), with the deep review-fix-signoff loop applied per slice.
- **Cloud callers**: any cloud caller (review surface, dashboard, scheduled runs) receives the same generated artifact contract. There is no separate cloud path in the normalized spec, so no cloud-only divergence is permitted.
- **MCP discipline**: generated runtime agents must **not** use Relaycast management or messaging tools (e.g. `mcp__relaycast__agent_add`, `add_agent`). The `list_integrations` MCP tool produced by P3 is itself a tool *exposed by* `packages/mcp-workforce`, not an MCP tool the workflow agents call.
- **Skill boundary**: the loaded skills (`choosing-swarm-patterns`, `relay-80-100-workflow`, `review-fix-signoff-loop`, `writing-agent-relay-workflows`) are generation-time only. They shaped the workflow contract, validation gates, review depth, and pattern selection. Generated runtime agents receive only the rendered workflow instructions — they do not load or embody skill files at runtime. Do not assert in implementation or review that runtime agents apply skills.
- **Artifact directory**: every generated artifact lives under `.workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/`. Reviewers, fixers, and signoff steps must cite paths inside that directory verbatim.

## Implementation contract

Constraints from `acceptance-contract.json.implementationContract`: `sourceChangesRequired: true`, `requireNonEmptyDiffEvidence: true`, `requireResultOrPrReporting: true`. Required lead-plan headings already enforced above; required sentinel `GENERATION_LEAD_PLAN_READY` ends this file.

### P1 — deploy core (foundational; P2 and P3 both depend on this)

- **New file**: `packages/deploy/src/integrations-list.ts`. Public surface:
  - `listIntegrations({ client?: CloudApiClient, workspaceId?: string }): Promise<IntegrationsDocument>` — returns the §6 `--json` shape verbatim.
  - Exported types: `IntegrationsDocument`, `IntegrationRow`, `IntegrationConnection`, `TriggerSource = "catalog" | "none"`, `AuthState = "authenticated" | "unauthenticated"`.
- **Data flow** (must match spec §4 exactly):
  1. Static import: `KNOWN_TRIGGER_CATALOG`, `KNOWN_TRIGGER_ALIAS_CATALOG`, `KNOWN_TRIGGER_PROVIDER_ALIASES`, `ADAPTERS_WITHOUT_KNOWN_TRIGGERS` from `@relayfile/adapter-core/triggers` (re-exported via persona-kit if that is the established hop in the repo; do not introduce a new direct dependency without checking existing module graph).
  2. Cloud calls (only when authenticated): `GET /api/v1/integrations/catalog`, `GET /api/v1/workspaces/{id}/integrations`, `GET /api/v1/me/integrations`, `GET …/integrations/{provider}/status` — exactly the calls `packages/deploy/src/connect.ts` already makes.
  3. Auth resolution: `readActiveWorkspace()` + `CloudApiClient` with env precedence `WORKFORCE_DEPLOY_CLOUD_URL → WORKFORCE_CLOUD_URL → default`, plus `WORKFORCE_WORKSPACE_ID`. Identical to the `deployments` command.
- **Row construction** (spec §5):
  - Union of cloud-catalog providers and trigger-catalog providers, alias-mapped through `KNOWN_TRIGGER_PROVIDER_ALIASES`.
  - Row key = cloud provider id. `adapterSlug === id` when no alias; otherwise carry both.
  - Per-row provenance: `inCloudCatalog: boolean`, `triggerSource: "catalog" | "none"`.
  - Trigger-catalog-only providers (missing from cloud catalog) → warning string `"<provider>: in trigger catalog but not in cloud catalog"` pushed to `warnings[]`. Not an error — drift signal.
  - Cloud-catalog providers with no known triggers → `triggers: []`, `triggerSource: "none"` (renderer surfaces "no known triggers (connect-only)").
- **Unauthenticated semantics** (spec §6 / §7.2 / §8):
  - When `auth: "unauthenticated"`: `connected` and `connections` are `null` on every row (not `false`, not `[]`).
  - Cloud catalog must still be fetched if reachable. If it is unreachable while unauthenticated, fall back to trigger-catalog only, mark each row `inCloudCatalog: false`, and emit a `warnings[]` entry naming the failure and explicitly saying the catalog is partial because cloud-only/connect-only integrations are omitted.
  - `--all` is a full union only when the cloud catalog is reachable. True offline/logged-out mode is trigger-catalog-only with the partial-catalog warning above; do not silently present it as the complete cloud union.
  - `listIntegrations` must **never throw** on missing login — the MCP tool depends on this.
- **Endpoint failure semantics** (spec §7.6):
  - Authenticated endpoint failures are loud: throw an `IntegrationsListError` carrying HTTP status + endpoint + body excerpt. CLI catches and prints the message to stderr and sets `process.exitCode = 1`.
  - Do **not** silently degrade to an empty table when an authenticated call fails.
- **Security**: filter out `configKey` from any cloud-catalog payload before constructing rows. Do not pass through OAuth tokens or session URLs. Add an inline assertion test that the output document JSON contains none of those keys.
- **Tests** (P1, in `packages/deploy`):
  - Mocked-fetch unit tests covering: merge correctness; alias display (`google-mail (gmail)`); unauthenticated nulls; trigger-catalog-only drift warning; cloud-catalog connect-only row; endpoint-failure loudness (throws `IntegrationsListError` with status code); `configKey` stripped.
  - Logged-out/offline fixture test covering cloud catalog failure: output has `auth: "unauthenticated"`, every row has `connected: null`, every row has `inCloudCatalog: false`, and `warnings[]` includes the partial-catalog text proving cloud-only/connect-only providers are omitted rather than silently returned.

### P2 — CLI presenter (depends on P1)

- **New file**: `packages/cli/src/integrations-command.ts`. Public surface:
  - `runIntegrationsCommand(args: string[], { stdout, stderr, env }): Promise<void>` — pure presenter over P1's `listIntegrations`.
- **CLI surface** (spec §3):
  - `agentworkforce integrations` — default status view, requires login. Logged-out → exit 1 with a two-line stderr hint pointing at `agentworkforce login` and `--all`.
  - `agentworkforce integrations --all` — full union catalog, works logged-out, `CONNECTED` column renders `?` when unauthenticated.
  - `agentworkforce integrations <provider>` — single-provider view; logged-out tolerated, alias-suggest on unknown provider (both directions: `gmail → google-mail` and `google-mail → gmail` as decided in §7.8). On unknown id with no alias match, exit 1 with the same suggest-valid-ids behavior the connect 409 path has.
  - `--json` — composes with all of the above; emits the §6 document only, no fencing, parseable as a single JSON document.
- **Dispatch**: register `integrations` in `packages/cli/src/cli.ts` next to `deployments` / `sources`. Add a USAGE block entry and a README section titled "Discover integrations and triggers".
- **Rendering** (spec §3.1–§3.3, §5):
  - Default/`--all` table: columns `PROVIDER`, `CONNECTED`, `SCOPE`, `TRIGGERS`. Provider display is `id` or `id (adapterSlug)` when aliased.
  - `CONNECTED`: `✓` when at least one connection; `—` when none in authenticated mode; `?` when `auth: "unauthenticated"`.
  - `SCOPE`: blank when not connected; otherwise space-joined unique scopes from `connections[]`.
  - `TRIGGERS`: `"<n> known (first, second, …)"` when `triggers.length > 0`; `"no known triggers (connect-only)"` when `triggerSource === "none"`; append `" — not in cloud catalog"` annotation when `inCloudCatalog === false`.
  - Single-provider view: full trigger list one per line; per-connection block with `connectionId`, `scope`, `serviceAccountName` when present, `status`; copy-pasteable `persona.json` + `agent.ts` snippet using verbatim adapter-namespace event name.
  - Sorting: alphabetical by cloud provider id (§7.5). Stable; do not float connected rows.
- **Streams** (§7.7): data → stdout; warnings, hints, errors → stderr. `--json` writes the document only to stdout, no banner.
- **Exit discipline** (§7.12): set `process.exitCode`; never call `process.exit()`. Tests drive the command directly.
- **Tests** (P2, in `packages/cli`):
  - Table rendering snapshot for authenticated and unauthenticated modes.
  - `--json` document shape parity test: produced JSON parses and matches the contract (`workspaceId`, `auth`, `integrations[]`, `warnings[]`).
  - Logged-out `--all` succeeds; logged-out default exits 1 with hint.
  - Logged-out/offline `--all --json` succeeds and preserves the partial-catalog warning in stderr plus `warnings[]`; the parsed JSON proves `connected: null` for every row.
  - Unknown provider → exit 1 with bidirectional alias suggestion.
  - Endpoint-failure path → exit 1, stderr carries HTTP status, stdout untouched.

### P3 — MCP tool (depends on P1 only; does **not** depend on P2)

- **New tool**: `list_integrations` in `packages/mcp-workforce`, backed by P1's `listIntegrations`.
  - Input schema: `{ provider?: string, includeTriggers?: boolean }` (default `includeTriggers: true`).
  - Output: §6 JSON contract, byte-identical to the CLI `--json` output for the same inputs (verify in a parity test). When `provider` is supplied, filter `integrations[]` to that row (apply alias mapping in both directions before filtering).
  - When `includeTriggers === false`, set every row's `triggers: []` and `triggerSource: "none"` in the emitted document — do not drop the fields.
- **Unauthenticated**: never throws. Returns catalog-only document with `auth: "unauthenticated"`, `connected`/`connections: null`.
- **Persona-maker pointer**: one-line pointer added to persona-maker guidance (persona or skill file already shipping with mcp-workforce / persona kit) telling the authoring agent to call `list_integrations` before writing `agent.triggers`. Do not refactor surrounding persona text.
- **Tests** (P3): authenticated path, unauthenticated path (no throw), `provider` filter (positive + alias + unknown), `includeTriggers: false` shape, byte-equality with CLI `--json` for a fixed mocked-fetch fixture.

### Cross-cutting implementation rules

- `IntegrationsDocument` shape lives in `packages/deploy/src/integrations-list.ts` and is the single source of truth. CLI and MCP tool import it; do not redeclare.
- `--json` evolution is additive-only (spec §6). Removing or renaming any field is a breaking change to both surfaces and must be rejected in review.
- No new top-level dependencies in `package.json` unless strictly required to reach the trigger catalog re-export already used by persona-kit.
- Every PR must produce a non-empty diff under `git diff --name-status main...HEAD`. The diff gate compares changed paths against the explicit inventory below, not against broad package scopes or read-only endpoint/reference labels; it fails when any required path is missing or any path outside `allowed_changed_paths` appears.

## Deliverables

Declared target boundary (carried from `deliverables.md`; this boundary includes read-only references and broad package scopes and is **not** the diff allowlist):

- `@relayfile/adapter-core/triggers` — **read-only import** of `KNOWN_TRIGGER_CATALOG`, `KNOWN_TRIGGER_ALIAS_CATALOG`, `KNOWN_TRIGGER_PROVIDER_ALIASES`, `ADAPTERS_WITHOUT_KNOWN_TRIGGERS`. No modifications.
- `packages/deploy/src/connect.ts` — **read-only reference** for existing endpoint shapes and `CloudApiClient` usage; do not modify behavior. If shared helpers are factored out into `integrations-list.ts`, the move must preserve `connect.ts` semantics exactly (verified by existing `connect.ts` tests staying green).
- `/me/integrations` — cloud endpoint referenced by P1's data-source layer. Not a file to edit; treat as an interface contract held by cloud.
- `packages/deploy/src/integrations-list.ts` — **new file**, P1 deliverable. Public `listIntegrations` plus exported document types.
- `packages/cli/src/integrations-command.ts` — **new file**, P2 deliverable. Thin presenter; dispatch wired in `packages/cli/src/cli.ts`; USAGE + README updated.
- `packages/mcp-workforce` — **new tool** `list_integrations`, P3 deliverable; persona-maker pointer line updated.
- `packages/deploy` — package-level scope marker indicating P1 unit tests + any necessary index re-exports land here.

### Change Inventory

The deterministic diff gate uses `.workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/change-inventory.json`. The inventory is split by role so required implementation files are not confused with read-only references or package-level scope markers.

- `required_changed_paths`:
  - `packages/deploy/src/integrations-list.ts`
  - `packages/deploy/src/integrations-list.test.ts`
  - `packages/deploy/src/index.ts`
  - `packages/cli/src/cli.ts`
  - `packages/cli/src/integrations-command.ts`
  - `packages/cli/src/integrations-command.test.ts`
  - `packages/cli/README.md`
  - `packages/mcp-workforce/src/tools/list-integrations.ts`
  - `packages/mcp-workforce/src/tools/list-integrations.test.ts`
  - `packages/mcp-workforce/src/server.ts`
  - `packages/mcp-workforce/src/server.test.ts`
  - `packages/mcp-workforce/src/index.ts`
  - `packages/mcp-workforce/README.md`
  - `packages/mcp-workforce/package.json`
- `allowed_changed_paths`: all required paths plus expected docs and package metadata:
  - `docs/plans/integrations-discoverability-spec.md`
  - `package-lock.json`
  - `pnpm-lock.yaml`
  - `.workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/change-inventory.json`
  - `.workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/codex-diff-gate-output.txt`
  - `.workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/codex-fix-loop-report.md`
  - `.workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/lead-plan.md`
  - `.workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/normalized-spec.md`
  - `.workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/normalized-spec.txt`
  - `.workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/acceptance-contract.json`
- `read_only_reference_paths`:
  - `@relayfile/adapter-core/triggers`
  - `packages/deploy/src/connect.ts`
  - `/me/integrations`
  - `packages/deploy`
  - `packages/mcp-workforce`

Per-slice PR output (per `requireResultOrPrReporting`):

- P1 PR — title prefix `feat(deploy):`, body cites spec §4 / §5 / §6 / §7.6 / §7.9 and acceptance criteria items 1, 4, 5, 6.
- P2 PR — title prefix `feat(cli):`, body cites spec §3 / §7.1 / §7.2 / §7.5 / §7.7 / §7.8 / §7.12 and acceptance criteria 1, 2, 3, 4, 6, 7.
- P3 PR — title prefix `feat(mcp-workforce):`, body cites spec §6 / §8 and acceptance criteria 4, 5, 6, 7.

Each PR description must include: declared change inventory, verification gate output excerpts (tsc, scoped tests), and a parity-check command summary where relevant (P3 cites the CLI/MCP JSON equality test).

## Verification gates

All gates from `verification-plan.md`, sequenced per slice. Gates between agent steps are deterministic — they exit non-zero when expected state is missing — and must run inside the slice that produces the change, not deferred to signoff.

Workflow-quality requirement: keep each agent step bounded to one coherent slice. P1, P2, P3 are independent agent fan-outs with their own review-fix-signoff sub-loop; do not merge implementation across slices to fit a single timeout.

### Per-slice gates (run after every implementation step within the slice)

1. **`file_exists` gate for declared targets** — assert each slice's new files exist with non-zero size. Example for P1:
   ```sh
   test -s packages/deploy/src/integrations-list.ts
   ```
2. **Deterministic structural sanity gate** — scoped to the slice's new content. Examples (all must exit non-zero on absence):
   - P1: `node -e "const m = require('./packages/deploy/dist/integrations-list.js'); if (typeof m.listIntegrations !== 'function') process.exit(1)"` after `npx tsc --noEmit` and slice build, or an equivalent inline TS check using `ts-node`.
   - P2: scoped grep with `command -v rg` guard:
     ```sh
     if command -v rg >/dev/null 2>&1; then
       rg -n 'process\.exit\(' packages/cli/src/integrations-command.ts && exit 1 || true
       rg -n 'integrations' packages/cli/src/cli.ts >/dev/null || exit 1
     else
       grep -n 'process\.exit(' packages/cli/src/integrations-command.ts && exit 1 || true
       grep -n 'integrations' packages/cli/src/cli.ts >/dev/null || exit 1
     fi
     ```
   - P3: inline assertion that the CLI `--json` and MCP `list_integrations` outputs are byte-identical for a fixed fixture (the parity test itself is the gate).
3. **Active-reference gate for deleted manifest paths** — no deletions are planned in this spec, but the gate must still run and pass trivially (no `D` entries in `git diff --name-status` for files under `packages/deploy/src`, `packages/cli/src`, `packages/mcp-workforce` outside an explicit relocation).
4. **`npx tsc --noEmit`** — workspace-wide. Must be green before the slice exits its review loop.
5. **Scoped tests**:
   - P1: `npm test --workspace='packages/deploy'`
   - P2: `npm test --workspace='packages/cli'` (plus `npm test --workspace='packages/deploy'` to confirm P1 regression-free)
   - P3: package tests for `packages/mcp-workforce` (per its existing test command) plus `npm test --workspace='packages/deploy'` and `npm test --workspace='packages/cli'` regression sweep.
   - The verification plan calls out `npm test --workspace='packages/cli' && npm test --workspace='packages/deploy'` as the minimum cross-slice green-bar.
6. **Git diff gate** — `git diff --name-status main...HEAD` must be non-empty and must equal (or be a subset matching) the declared change inventory for the slice. The gate fails when the diff is empty (`requireNonEmptyDiffEvidence: true`) or when an unexpected file outside the inventory was modified.
7. **PR URL or explicit result summary** — the slice's signoff step posts the PR URL (or, for local-only runs, an explicit summary that names the commit SHA, branch, and gate outputs). Required by `requireResultOrPrReporting: true`.

### Workflow-level gates (run before final signoff after all three slices)

- Full workspace `pnpm run check` (acceptance criterion 7).
- Re-run `npx tsc --noEmit` across the workspace once P3 is merged into the integration branch.
- Final review-fix-signoff loop: dual independent reviewers (Claude + Codex) per `review-fix-signoff-loop`; signoff only when both agree. Reviewers must verify:
  - No `--scope`, caching, or connected-first sort introduced.
  - No `process.exit()` calls in new code (grep gate).
  - No `configKey`, OAuth token, or session URL strings in any emitted document or test fixture.
  - CLI `--json` and MCP `list_integrations` outputs are byte-identical for the parity fixture.
  - `listIntegrations` does not throw under unauthenticated mode (test asserted).
  - Endpoint-failure paths exit 1 loudly with HTTP status visible (test asserted).

### Tooling-failure fallback

- For any `rg`-based gate, the fallback shown above (`command -v rg` guard with `grep` / `git grep` fallback) must be present so the workflow does not silently skip a check on machines without ripgrep.
- Cleanup or deletion artifacts are not expected for this spec; if a slice ends up deleting a file, the verification plan's cleanup-report contract activates: write `.workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/cleanup-report.md` citing `.workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/cleanup-candidate-prescan.txt` and persist a `git diff --name-status` inventory plus active-reference evidence for each deleted path.

GENERATION_LEAD_PLAN_READY
