# Deploy-v1 Credentials + Runtime Checklist

Source spec: `docs/plans/deploy-v1-credentials-and-runtime-spec.md`

## Acceptance

- [x] Fresh laptop install path works with `npm install -g @agentworkforce/cli`.
- [x] `agentworkforce login` opens PKCE browser login and stores auth in keychain-backed storage.
- [x] `agentworkforce deploy ./personas/notion-essay-pr.json --mode cloud` runs without manual workspace env vars.
- [x] Notion `page.created` trigger is represented in the deployed persona.
- [x] Cloud runtime spins up a Daytona sandbox for the Notion event.
- [x] Harness can read Notion page content through `ctx.files.read(...)`.
- [x] Handler drafts markdown essay to `/workspace/output/<page-id>.md`.
- [x] Harness opens a GitHub PR with the workspace service account `release-bot`.
- [x] `agentworkforce list` shows the running agent.
- [x] `agentworkforce destroy <agentId>` tears the agent down.

## Section 1: Schema Completions

- [x] Add cloud migration `0043_*` after `0042_agents_schedule_webhook_secret_hash`.
- [x] Rename `cloud_agents` to `provider_credentials`.
- [x] Rename `cloud_agent_auth_sessions` to `provider_credential_auth_sessions`.
- [x] Rename auth-session FK column `cloud_agent_id` to `provider_credential_id`.
- [x] Add `provider_credentials.model_provider`.
- [x] Add `provider_credentials.auth_type`.
- [x] Add `provider_credentials.label`.
- [x] Backfill `model_provider` from `harness`.
- [x] Add `provider_credentials_auth_type_check`.
- [x] Add provider credential uniqueness for user, workspace, provider, auth type, label, and key fingerprint.
- [x] Create `harness_spend_events`.
- [x] Add spend-event indexes by credential/time and user/time.
- [x] Rename `cli_auth_sessions` to `cloud_cli_bootstrap_sessions`.
- [x] Rename TS binding `cliAuthSessions` to `cloudCliBootstrapSessions`.
- [x] Update every cloud web route importer of the renamed CLI session binding.
- [x] Migrate `slack_channel_configs` rows into `integration_scopes`.
- [x] Drop `slack_channel_configs`.
- [x] Rewrite cloud lib call sites from `slack_channel_configs` / `slackChannelConfigs` to `integration_scopes`.
- [x] Add Drizzle TS binding for `personas`.
- [x] Add Drizzle TS binding for `userIntegrations`.
- [x] Add Drizzle TS binding for `integrationScopes`.
- [x] Add Drizzle TS binding for `workforceCliAuthSessions`.
- [x] Add Drizzle TS binding for `cloudCliBootstrapSessions`.
- [x] Delete `slackChannelConfigs` binding.
- [x] Add proper Drizzle journal entry and snapshot chained from `0042_*`.
- [x] Verify `web:drizzle-journal:test` passes.
- [x] Verify `packages/web` typecheck passes.

## Section 2: Login Flow

- [x] Replace `runLogin` env-var stub with `@agent-relay/cloud` auth flow.
- [x] Parse login options including `--cloud-url` and `--workspace`.
- [x] Call the published `@agent-relay/cloud` `ensureAuthenticated` SDK entrypoint for PKCE login.
- [x] List workspaces with `CloudApiClient`.
- [x] Pick the single workspace automatically.
- [x] Add interactive workspace picker when multiple workspaces exist.
- [x] Mint workspace token with `issueWorkspaceToken`.
- [x] Persist workspace token with new `writeStoredWorkspaceToken`.
- [x] Add workspace-token store in `packages/deploy/src/login.ts`.
- [x] Update `resolveWorkspaceToken` precedence: explicit flags first.
- [x] Preserve env fallback via `WORKFORCE_WORKSPACE_ID` + `WORKFORCE_WORKSPACE_TOKEN`.
- [x] Read keychain-stored workspace token before prompting.
- [x] Throw a clear `--no-prompt` error when no token is available.
- [x] Prompt user to run `agentworkforce login` when prompting is allowed.
- [x] Add `agentworkforce logout`.
- [x] Ensure logout clears user auth and workspace token.
- [x] Ensure deploy/destroy/list work without `WORKFORCE_WORKSPACE_ID` after login.
- [x] Add tests for `runLogin` auth + workspace-token mint.
- [x] Add tests for workspace-token persistence.
- [x] Add `resolveWorkspaceToken` precedence tests.
- [x] Add logout tests.

## Section 3: Provider Credentials

- [x] Preserve existing `provider_oauth` sandbox flow.
- [x] Add BYOK cloud route `POST /api/v1/workspaces/{ws}/provider-credentials/byok`.
- [x] Validate Anthropic BYOK keys against provider models endpoint.
- [x] Validate OpenAI BYOK keys against provider models endpoint.
- [x] Encrypt BYOK with `encryptCredential`.
- [x] Store BYOK envelope with `storeCredential`.
- [x] Insert BYOK `provider_credentials` row as connected.
- [x] Make BYOK same-key/same-label path idempotent.
- [x] Add managed credential route `provider-credentials/managed?provider=<p>`.
- [x] Add SST secrets `HouseAnthropicKey`, `HouseOpenaiKey`, `HouseGoogleKey`, `HouseOpenrouterKey`.
- [x] Document house key setup in `cloud/infra/README.md`.
- [x] Add `resolveHouseKey(modelProvider)`.
- [x] Return clear 503 when a managed provider house key is missing.
- [x] Insert `relay_managed` provider credential rows without S3 blobs.
- [x] Add `applyMarkup` and `markupOnly`.
- [x] Add provider rates helper.
- [x] Record `harness_spend_events` from harness usage reports.
- [x] Compute raw cost from token counts and provider rates.
- [x] Compute markup only for `relay_managed`.
- [x] Emit monthly soft-cap warning over $100.
- [x] Wire CLI `--harness-source byok --byok-key` to BYOK route before deploy.
- [x] Wire CLI `--harness-source managed` to managed credential route before deploy (`plan` remains a legacy alias).
- [x] Preserve CLI `--harness-source oauth` behavior.
- [x] Add cloud BYOK route tests.
- [x] Add cloud managed route tests.
- [x] Add spend insert path test.
- [x] Add markup unit test for $1.00 to $1.30.
- [x] Add soft-cap warning test.

## Section 4: List CLI Completeness

- [x] Add cloud route `GET /api/v1/workspaces/{workspaceId}/deployments`.
- [x] Enforce workspace membership and `deployments:read` or `cli:auth` scope.
- [x] Return non-destroyed agents by default.
- [x] Support `?status=` filter.
- [x] Support `?personaId=` filter.
- [x] Support cursor pagination by `createdAt + id`.
- [x] Add `packages/cli/src/list-command.ts`.
- [x] Read workspace token in list command.
- [x] Fetch deployments list route.
- [x] Render human-readable table.
- [x] Support `agentworkforce list --status <s>`.
- [x] Support `agentworkforce list --persona <slug>`.
- [x] Support `agentworkforce list --json`.
- [x] Wire list command into CLI dispatch.
- [x] Update CLI help text.
- [x] Add cloud route tests for happy path, pagination, and filters.
- [x] Add workforce list CLI tests for table and JSON output.

## Section 5: Sandbox Runtime Wiring

- [x] Add `cloud/packages/web/lib/proactive-runtime/agents-md.ts`.
- [x] Implement `renderAgentsMd(input)`.
- [x] Include agent id and deployed name in AGENTS.md.
- [x] Include persona id, version, harness, model, and system prompt.
- [x] Render resolved integrations without secrets.
- [x] Render schedules.
- [x] Render relaycast workspace, agent name, and default workspace id.
- [x] Include loud holes section.
- [x] Write `/workspace/AGENTS.md` during sandbox bootstrap.
- [x] Add `relayfileMountPaths` to persona deploy preparation.
- [x] Derive relayfile mount paths from integration scopes.
- [x] Derive relayfile mount paths from memory scopes.
- [x] Pass `--paths` args to `relayfile-mount`.
- [x] Extend sandbox env with `RELAY_AGENT_NAME`.
- [x] Extend sandbox env with `RELAY_DEFAULT_WORKSPACE`.
- [x] Add `renderAgentsMd` tests for content, no secrets, and stable order.
- [x] Add `preparePersonaDeploy` relayfile mount paths test.
- [x] Add launcher test for relayfile `--paths`.

## Section 6: Supermemory Wiring

- [x] Add cloud memory route `POST /api/v1/workspaces/[workspaceId]/memory`.
- [x] Add cloud memory route `GET /api/v1/workspaces/[workspaceId]/memory`.
- [x] Authenticate memory routes with sandbox agent token.
- [x] Resolve `global` memory space.
- [x] Resolve `workspace` memory space.
- [x] Resolve `user` memory space.
- [x] Bind `sageSupermemoryApiKey` to web service.
- [x] POST saved memories to supermemory.
- [x] GET vector recall from supermemory.
- [x] Return normalized `{ id }` on save.
- [x] Return normalized recall items.
- [x] Replace workforce `ctx.memory.save` no-op with cloud call.
- [x] Replace workforce `ctx.memory.recall` no-op with cloud call.
- [x] Source `cloudBaseUrl`, `workspaceId`, and `agentToken` from sandbox env.
- [x] Preserve recall network-failure fallback to `[]`.
- [x] Add cloud memory route tests.
- [x] Add workforce ctx.memory tests.

## Section 7: Runtime Picker UX

- [x] Add `packages/cli/src/runtime-picker.ts`.
- [x] Prompt for runtime when no `--mode` is passed and stdout is a TTY.
- [x] Return cloud mode for AgentRelay choice.
- [x] Return sandbox mode for local sandbox choice.
- [x] Return dev mode for local dev choice.
- [x] Print runtime docs URL and exit 0 for build-your-own choice.
- [x] Bypass picker when `--mode` is passed.
- [x] Bypass picker when `--no-prompt` is passed.
- [x] Bypass picker when stdin/stdout is non-TTY and keep parse error behavior.
- [x] Add stdin-injected picker tests.
- [x] Add bypass tests.

## Section 7.5: Integration Auto-connect

- [x] Audit cloud integration list route shape.
- [x] Audit cloud connect-session route shape.
- [x] Audit cloud provider status route shape.
- [x] Add `relayfileIntegrationResolver` to `packages/deploy/src/connect.ts`.
- [x] Implement `isConnected` using cloud integration list route.
- [x] Implement `connect` using connect-session route.
- [x] Open browser to integration session URL.
- [x] Poll provider status until connected.
- [x] Timeout with clear provider-specific error.
- [x] Wire cloud-mode deploy to use `relayfileIntegrationResolver`.
- [x] Keep dev and sandbox modes on `envIntegrationResolver`.
- [x] Extract required providers from `persona.integrations`.
- [x] Preflight each required provider before deploy.
- [x] Prompt to connect missing integrations.
- [x] Fail fast under `--no-prompt` when integrations are missing.
- [x] Abort deploy if any integration connect fails.
- [x] Skip prompts for already-connected integrations.
- [x] Add resolver unit tests.
- [x] Add runDeploy integration preflight tests.

## Section 8: Customer Scenario

- [x] Add `workforce/examples/notion-essay-pr/persona.json`.
- [x] Add `examples/notion-essay-pr/agent.ts` if persona authoring needs a concrete handler.
- [x] Add Notion trigger in reference persona.
- [x] Add GitHub workspace service account source in reference persona.
- [x] Add `NOTION_SOURCE_DATABASE` input.
- [x] Add `GITHUB_TARGET_REPO` input.
- [x] Add workspace memory scope to reference persona.
- [x] Add `notion-essay-pr.smoke.test.ts`.
- [x] Mock supermemory in smoke test.
- [x] Mock Notion page-created payload in smoke test.
- [x] Mock GitHub PR creation in smoke test.
- [x] Assert sandbox spawned in smoke test.
- [x] Assert AGENTS.md written in smoke test.
- [x] Assert Notion page read through `ctx.files.read`.
- [x] Assert essay written through `ctx.files.write`.
- [x] Assert GitHub PR create call.
- [x] Add customer onboarding guide.
- [x] Document install, login, persona config, deploy, list, Notion test, and destroy.

## Section 9: Migration + Deploy Plan

- [x] Keep cloud PR ordered by schema, provider credentials, spend, routes, memory, sandbox wiring.
- [x] Keep workforce PR ordered by login, logout, list, harness sources, picker, memory, reference persona, e2e, docs.
- [x] Document SST house key prerequisites.
- [x] Confirm merge order: cloud PR, SST prod deploy, workforce PR, CLI publish, onboarding published.

## Section 10: Test Plan

- [x] Run schema journal tests.
- [x] Run cloud typecheck.
- [x] Run workforce login tests.
- [x] Run provider credential tests.
- [x] Run spend tracking tests.
- [x] Run list route and CLI tests.
- [x] Run destroy/list regression where available.
- [x] Run AGENTS.md generation tests.
- [x] Run relayfile mount tests.
- [x] Run memory route tests.
- [x] Run ctx.memory tests.
- [x] Run Notion to essay to PR smoke test or document blocker.

## Section 11: Explicit Defers

- [x] Leave `default_runtime jsonb` flattening out of scope.
- [x] Treat hard spend caps as out of scope.
- [x] Treat per-org markup override as out of scope.
- [x] Treat BYOK credential rotation as out of scope.
- [x] Treat finer global-memory permissions as out of scope.
- [x] Treat post-migration slack cross-tenant validation script as out of scope.

## Section 12: Risk Controls

- [x] Manually review `cloud-agents` route rename surface.
- [x] Avoid logging house key values.
- [x] Add protection against accidental house-key logging where practical.
- [x] Preserve memory outage fallback behavior.
- [x] Ensure keychain first-write UX errors are actionable.
- [x] Verify Notion and GitHub not-connected errors are covered.
