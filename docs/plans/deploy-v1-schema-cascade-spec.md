# Ricky workflow spec — Deploy v1 schema cascade + persona refactor

**Status:** ready for Ricky to generate + run a workflow.
**Resolves:** locked-in decisions from cloud#553 thread + two May 12 architecture meetings.
**Companion docs:**
- `workforce/docs/plans/deploy-v1.md` (product plan)
- `workforce/docs/plans/deploy-v1-codex-spec.md`
- `workforce/docs/plans/deploy-v1-workflow-spec.md` (reference workflow shape — mirror conventions)

**Reference workflow file (shape to mirror):** `cloud-proactive-runtime-spec/workflows/proactive-runtime-m1.ts`

**Hard precondition (cleared):** workforce#95 (`refactor/flatten-persona-tiers`) **MERGED 2026-05-12T21:09:01Z**. All tracks may start.

**Current state of upstream dependencies (verify at workflow start):**
- workforce#95 — **MERGED 2026-05-12T21:09:01Z**. Hard gate cleared.
- relay#844 — **MERGED 2026-05-12T19:50:04Z**; `@agent-relay/events@6.0.17` + `@agent-relay/agent@6.0.17` published. Track C coordination comment already posted.
- agent-assistant#91 — MERGED; `@agent-assistant/proactive@0.4.32` published. Track E4 picks this up.
- workforce#97 (`feat/persona-integration-source`) — DRAFT, ready for rebase in Track E5 after Track D.
- cloud#548 (now M1-M6, title stale) — open, +33k/-57. Trigger registration code VERIFIED (schedules → relaycron via `services/agent-gateway/src/relaycron-client.ts:registerCronSchedules()`; watches → gateway DO via `packages/agent-relay-agent/src/index.ts:registerWatches()` at agent startup). Missing piece for persona+bundle deploy: persona → watch-glob translation; lives in Track G below. **Track A must rebase on #548's migrations if #548 merges first; review showed #548 is additive on existing `agent_deployments`, so two-table split is layerable.**
- relay#843 — open, +3.5k. Adds `agent-relay` CLI commands (login/workspaces/tokens/dlq/runtime) + new `@agent-relay/cloud` library. **Parallel to workforce CLI; no spec dependency.**
- relaycron#5 — open, +2k. WS-delivery + cancel API + buffered ticks. **Track G dependency** — without this merged, schedule registration via the agent-gateway's `relaycron-client.ts` is half-wired. Preflight Track G to verify relaycron#5 is merged.
- relayauth#39 — open, docs-only +3/-1. No spec impact.
- cloud#554 (Daytona meter) — draft, platform-team gates only.
- cloud#555 (workflow-invocations shim) — draft, 2 follow-ups in Track J.

---

## How to consume

Generate one workflow TS file (suggested name `workforce-schema-cascade.ts`) under `cloud-proactive-runtime-spec/workflows/` that orchestrates the six tracks below.

- Tracks A and C run on cloud; D, E, F on workforce.
- A, C may run in parallel from workflow start.
- B depends on A.
- D depends on workforce#95 merged.
- E depends on D.
- F depends on D merged AND A merged.

### Run command

```sh
npx tsx cloud-proactive-runtime-spec/workflows/workforce-schema-cascade.ts
```

### Required env

```
HOME=/Users/khaliqgant
ROOT=$HOME/Projects/AgentWorkforce

CLOUD_REPO=$ROOT/cloud
WORKFORCE_REPO=$ROOT/workforce
RELAY_REPO=$ROOT/relay              # read-only — verify relay#844 merge state
```

### Required secrets

```
GITHUB_TOKEN
```

### Coordination

Hub-spoke. Lead Claude Opus stays on `#wf-schema-cascade` as architect + ambient reviewer.

### Never-fail mechanics (mirror `proactive-runtime-m1.ts`)

- Every test / typecheck / regression gate runs as **soft → fixer → hard**.
- Two review rounds: peer review → signoff → router → fix-r2 → final signoff. If round 2 still has gaps, the PR opens as DRAFT with the gap list in the body. Workflow exits 0.
- Global `onError`: retry 2× with 10s backoff.
- Per-track self-reflection vs that track's section below.

### Worktree layout

```
$CLOUD_REPO                                     # Track A (issue body + migrations PR) — operates in place
$CLOUD_REPO.wt-resolver                         # Track B
$WORKFORCE_REPO                                 # Track D (persona-kit refactor — owns primary checkout)
$WORKFORCE_REPO.wt-runtime                      # Track F (runtime input-values resolution)
$WORKFORCE_REPO.wt-rebase-92                    # Track E sub-tracks (one worktree per workforce PR)
$WORKFORCE_REPO.wt-rebase-93
$WORKFORCE_REPO.wt-rebase-94
$WORKFORCE_REPO.wt-rebase-96
$WORKFORCE_REPO.wt-rebase-97
```

Create with `git worktree add <path> -b <branch> <base>`. Cleanup: never run `git worktree remove`. Leave worktrees in place for human inspection.

### PR conventions

- **PRs open as DRAFT initially. Workflow auto-flips to ready + AUTO-MERGES** when all gates pass (see Auto-merge directive below). Khaliq has explicitly authorized auto-merge for this workflow so when he wakes up everything is wired and ready to test.
- Title format: `<type>(<scope>): <summary>`.
- Body references this spec file path (`workforce/docs/plans/deploy-v1-schema-cascade-spec.md`) and a per-track acceptance checklist (checked/unchecked).
- Commit trailer: `Co-Authored-By: <implementer model> via Ricky <noreply@agentworkforce.com>`.
- No `--no-verify`. Fix hook failures and create a new commit.

### Auto-merge directive (FLIP from prior DRAFT-only posture)

After each track's PR is opened, the workflow's lead Claude:

1. **Waits for CI green** on the PR (all required checks passing, no failures, no in-progress).
2. **Runs the soft → fixer → hard gate loop** until tests + typecheck are clean.
3. **Verifies all upstream dependencies are merged** (per the Merge DAG below).
4. **Verifies no merge conflicts** with target base branch.
5. **Verifies no human review has requested changes** (`gh pr view --json reviews` returns no `CHANGES_REQUESTED` from a non-bot reviewer).
6. **Flips PR from draft to ready** (`gh pr ready <num>`).
7. **Merges via squash** (`gh pr merge <num> --squash --auto`) — uses `--auto` so if CI is still settling, GitHub merges as soon as it goes green.
8. **Posts a status line into `#wf-schema-cascade`**: "merged: <PR> (#X)".

**Gates that BLOCK auto-merge** (workflow stops cascade, posts loud alert):
- Any required CI check returns FAILURE after the fixer loop.
- Any human reviewer left `CHANGES_REQUESTED` (don't override).
- Merge conflict that fixer can't resolve.
- A downstream-track PR was already opened and its CI breaks post-merge of an upstream track → STOP, do not merge further.

**Cross-repo merge ordering:** the workflow walks the Merge DAG (below) topologically. Within a single repo, tracks merge sequentially. Across repos, paired-contract PRs (cloud#548 + relaycron#5) merge as a pair via short polling: workflow merges cloud#548 first, then immediately verifies relaycron#5 still green + merges it; if relaycron#5 breaks in between, the workflow flags it but doesn't roll back cloud#548 (Khaliq handles).

**What the workflow will NOT auto-merge:**
- workforce#89 (README rewrite — DRAFT by design, docs polish, not blocking).
- workforce#87 (proactive-agent-builder persona) — auto-merge IF #87 still has the `parseInputsShape` `optional: true` regression fix, since Track F's input resolution depends on it. Otherwise skip.
- cloud#554 (Daytona meter) — platform-team gates on meter name + autostop reconciliation; flag for Khaliq's morning review, don't merge.
- Anything in the "Out of scope" list.

**Rollback policy:** the workflow doesn't auto-revert. If a merge breaks a downstream track, the workflow stops, posts the broken state, and leaves all repos in their merged-so-far state for Khaliq to inspect. This is intentional: incomplete cascade is recoverable; rolling back partial cross-repo merges is not.

---

## Out of scope (DO NOT implement)

The following decisions were explicitly punted in the May 12 meetings. **Ricky must NOT enact any of these.** If an implementer agent proposes changes in these areas, fail the soft-gate.

1. **Multi-persona collaboration team table.** `agent_teams` or similar grouping table is NOT in v1. RelayCast workspace IS the de facto grouping; the only multi-agent observability is the `spawned_by_agent_id` back-pointer in Track A.
2. **Persona-spec timeout fields.** Timeouts are runtime-managed for v1 with sensible defaults per `trigger_kind`. Don't add `timeout_seconds` to `PersonaSpec`.
3. **`workforce deployments destroy/list` CLI commands.** M3 milestone — separate workflow file.
4. **Persona-personality-builder tool.** Future package; not part of persona-kit v1.
5. **Trait → expression auto-mapping** in the proactive bridge. Traits removed entirely from persona spec (Track D); no replacement in v1.
6. **LLM-judge timeout resumption logic.** Khaliq mentioned as "an option for later" — runtime layer, not schema.
7. **`@workforce/daytona-runner` npm publish.** A separate agent is handling publishing under the `@workforce` OIDC trusted-publisher scope. Do NOT touch the daytona-runner package or its workspace ref in this workflow.

### Loud hole: memory wiring (intentionally out of scope, intentionally loud)

Memory is NOT wired end-to-end after this workflow completes. The schema has the supermemory pointer in External state, and `PersonaSpec.memory` declares `scopes` + `ttlDays`, but **the runtime does not inject the supermemory API key, does not call save/recall, and `ctx.memory` returns a stub.**

This is a deliberate hole. Memory architecture is being worked through separately. After this workflow lands:

- `ctx.memory.save(...)` will type-check and compile, but at runtime it will log a warning and no-op.
- `ctx.memory.recall(...)` returns `[]`.
- A deployed agent that calls memory APIs runs cleanly but has no persistence.

**When memory IS wired** (separate follow-up spec), the locked decisions from the May 12 diagrams are:

- `enabled: bool`
- `scopes: 'workspace' | 'user' | 'global'` (per image 1 of the whimsical diagram — note: **no `session` scope, and a `global` scope is added** vs the old deploy-v1.md prose).
- `ttl: number`

Track D's persona-kit refactor MUST keep `PersonaSpec.memory.scopes` accepting `'workspace' | 'user' | 'global'` (drop `session` from the accepted union if it's there from pre-flatten code).

**Document the hole prominently:** every track's PR body MUST include the following line in a "Known gaps after this PR" section:

> ⚠️ **Memory is not wired.** `ctx.memory` is a stub in v1; see `docs/plans/deploy-v1-schema-cascade-spec.md` § Loud hole. Memory wiring lands in a follow-up workflow (not yet specced).

A separate spec — `docs/plans/deploy-v1-memory-spec.md` — will own the wiring. Out of scope here.

### Terminology notes (diagram ↔ schema)

The May 12 whimsical diagrams use a few names that differ from the locked schema. Ricky must use the **schema** names in code and migrations; diagram names are informal aliases.

| Diagram term | Schema term | Notes |
|---|---|---|
| `harnesses` table | `provider_credentials` | The "user-owned llm credential" row — `(user_id, model_provider, auth_type, label)`. The diagram's "harness" is the runner program (claude code, codex, opencode); the row is the credential to run it. Schema name `provider_credentials` stays. |
| `harnessShare` field | `provider_credentials.label` (or N/A) | The diagram's right-side table sketch was lossy here; treat as informal. |
| "Listeners" (image 1, item 4) + "schedule" (image 1, item 5) | `PersonaSpec.integrations.<p>.triggers[]` + `PersonaSpec.schedules[]` | Listed adjacently in image 1; spec keeps the existing shape with listeners as the unifying narrative (Track D JSDoc). |
| "Setup relaycast environment + agents.md with relaycast credentials" (image 3) | Runtime concern in cloud#548's agent-gateway, NOT a persona-spec field | Every deployed agent gets relaycast wired so it can communicate. Doesn't require the persona to declare an `inbox` listener. |

---

## Track A — Cloud #553 schema lock-ins (issue body + migrations PR)

**Repo:** `$CLOUD_REPO` (operates in place — single track on this repo at a time)
**Implementer model:** codex (high reasoning).
**Working branch:** `chore/db1-schema-lockin`
**PR title:** `feat(db): DB1 schema lock-ins per cloud#553 thread`

**Allowed-dirty regex:** `package(-lock)?\.json|packages/web/drizzle/.*|packages/web/lib/db/.*|packages/web/lib/proactive-runtime/.*|docs/.*`

### A1 — Update issue body of cloud#553

Read the current issue body first:
```bash
gh issue view 553 --repo AgentWorkforce/cloud --json body -q .body > /tmp/553-current.md
```

Edit the body to reflect ALL of the following lock-ins. If a lock-in is already in the body (Will has applied some already), leave it; only add what's missing.

#### Two-table agent model (multi-instance per persona)

Replace the existing single `agent_deployments` definition with a two-table model:

**`agents`** — persona-level, addressable identity. One row per `(workspace_id, persona_id)` not yet destroyed.

| Column | Notes |
|---|---|
| `id` uuid PK | The addressable agent ID — used in inter-agent communication, billing, observability grouping |
| `workspace_id` uuid FK→workspaces | |
| `persona_id` uuid FK→personas | |
| `deployed_name` text | denorm of `persona.slug` at deploy time |
| `deployed_by_user_id` uuid FK→users | |
| `credential_selections` jsonb | per-provider credential pick |
| `input_values` jsonb | per-deployment overrides for `persona.spec.inputs` |
| `pinned_version_id` uuid NULL FK→persona_versions | when NULL, agent tracks persona's latest version |
| `spec_hash_at_deploy` text | for "agent is behind persona" UI |
| `status` enum | `active \| disabled \| error \| destroyed` |
| `destroyed_at` timestamptz NULL | |
| `destroyed_by_user_id` uuid NULL | |
| `spawned_by_agent_id` uuid NULL FK→agents(id) | observability when one agent spawns another |
| `last_used_at`, `last_error` | |

`UNIQUE (workspace_id, persona_id) WHERE status != 'destroyed'`
`UNIQUE (workspace_id, deployed_name) WHERE status != 'destroyed'`

**`agent_deployments`** — per-running-instance row (a "head"). Many rows per `agents.id`. Two simultaneous Linear-ticket triggers for the same agent fan out to two `agent_deployments` rows under one `agents` row.

| Column | Notes |
|---|---|
| `id` uuid PK | per-instance ID |
| `agent_id` uuid FK→agents | |
| `trigger_kind` text | `'inbox' \| 'clock' \| 'radio'` |
| `trigger_payload` jsonb | what fired this deployment (cron name, integration event envelope, inbox message id, etc.) |
| `started_at`, `last_active_at` timestamptz | |
| `status` enum | `running \| idle \| timed_out \| completed \| failed` |
| `spec_hash_at_run` text | snapshot of which spec version this instance executed |
| `timed_out_at` timestamptz NULL | set when this deployment times out |
| `compaction_summary` text NULL | LLM-summarized conversation written when this deployment compacts |
| `parent_deployment_id` uuid NULL FK→agent_deployments(id) | chain to prior compaction so the "thread" of a conversation is reconstructable |

Add a `## Multi-instance + compaction semantics` section in the issue body:

> A single `agents` row can have N concurrent `agent_deployments`. Two simultaneous triggers (e.g. two Linear tickets arriving for the same MSD agent) fan out to two `agent_deployments` rows. Each deployment has its own conversation context.
>
> **Timeouts are runtime-managed**, per `trigger_kind`: human DM ≈ 5 min idle, GitHub review ≈ 24h, etc. (not in persona spec for v1.)
>
> **On timeout: compaction.** Runtime runs a compaction step — LLM summarizes the conversation; `compaction_summary` written; `timed_out_at` set; status moves to `timed_out`. The next trigger creates a new `agent_deployments` row with `parent_deployment_id` pointing at the timed-out row; the new row's system prompt is seeded from the parent's `compaction_summary`.

#### Integrations — two-table model

Already in body per Will's earlier edits — verify:
- `user_integrations` + `workspace_integrations`, nullable `name`, partial-unique indexes. `workspace_service_accounts` absorbed via `name IS NOT NULL`.

Add if missing:
- **`adapter` column on both integration tables** — `text NOT NULL DEFAULT 'nango'`, values `'nango' | 'composio' | 'pipedream'`. Will explicitly: "There should be adapter." Cloud already brokers via Composio (`packages/web/lib/integrations/composio-service.ts`); Pipedream is in the picture too.

#### `integration_scopes` generic table — replaces `slack_channel_configs`

```
integration_scopes
  id uuid PK
  user_integration_id uuid NULL FK→user_integrations(id)
  workspace_integration_id uuid NULL FK→workspace_integrations(id)
  scope_kind text       -- 'slack_channel' | 'github_repo' | 'jira_project' | 'notion_database' | …
  scope_id text         -- provider-side id (channel id, repo full_name, project key, …)
  config_json jsonb     -- per-kind extras (enabled flag, mode, etc.), zod-validated by scope_kind
  created_at, updated_at
  CHECK ((user_integration_id IS NULL) <> (workspace_integration_id IS NULL))
  UNIQUE (user_integration_id, scope_kind, scope_id) WHERE user_integration_id IS NOT NULL
  UNIQUE (workspace_integration_id, scope_kind, scope_id) WHERE workspace_integration_id IS NOT NULL
```

Mirrors the two-table integration pattern via two nullable FKs + CHECK.

#### `persona_versions` table — in v1

```
persona_versions
  id uuid PK
  persona_id uuid FK→personas
  version int
  spec jsonb
  spec_hash text
  created_at timestamptz
  UNIQUE (persona_id, version)
  UNIQUE (persona_id, spec_hash)
```

Add authoring note: "The persona-maker authoring agent writes a new `persona_versions` row on each persona edit. No separate version-management UI in v1."

`agents.spec_snapshot jsonb` is removed; replaced by `agents.pinned_version_id uuid NULL FK→persona_versions(id)`. When NULL, agent tracks persona's latest version.

#### `cli_auth_sessions` split

Rename existing table → `cloud_cli_bootstrap_sessions` (preserves Daytona + SSH bootstrap shape).

Add new:
```
workforce_cli_auth_sessions
  id uuid PK
  user_id uuid FK→users
  code_challenge text
  code_challenge_method text
  state text
  redirect_uri text
  token_hash text NULL          -- set on successful exchange; nulled on revoke
  issued_at, exchanged_at, expires_at, revoked_at timestamptz
```

#### Sharing rule prose

Replace any "OAuth credentials cannot be shared org-wide" language with:

> A persona can be shared org-wide regardless of credential type. The persona itself is shareable; credentials are deployer-scoped. Deploys fail with a clear error when the deploying user hasn't connected the required credential.

#### GitHub App + user OAuth combine (resolution flow doc)

Add to §"Resolution at deployment-run time":

> For provider `github`, `source: { kind: 'deployer_user' }` loads the deployer's `user_integrations` row **and** the workspace's matching `workspace_integrations` row (matching workspace + provider, `name IS NULL`). Both are required at runtime: the App install gates repo access (workspace `installation_id`); the user OAuth identifies the actor.

#### Sub-agents / teams note

Add to schema doc:

> **Harness sub-instances** inside a handler invocation are captured in `session_events`, not new `agents` or `agent_deployments` rows.
>
> **Multi-persona teams.** When agent A spawns agent B (a different persona), B gets its own `agents` row. RelayCast workspace IS the de facto team grouping in v1; no new `agent_teams` table. `agents.spawned_by_agent_id NULL` is the observability back-pointer.

#### External state: sandbox-minute metering

Add row to the External state table:

| Concern | Stored in | How DB1 references it |
|---|---|---|
| Sandbox-minute usage events | platform metering pipeline (emitted via structured `logger.info` from `packages/web/app/api/v1/workspaces/[workspaceId]/sandboxes/workforce-sandbox-meter.ts`) | events carry `agent_id`, `workspace_id`, `sandbox_id`; no DB1 row; reconcile in billing dashboard |

#### Lock-in revision history

Add a `## Lock-in revision history` section at the bottom of the issue body referencing this workflow run + the May 12 transcripts + the date.

Apply via:
```bash
gh issue edit 553 --repo AgentWorkforce/cloud --body-file /tmp/553-updated.md
```

### A2 — Open migrations PR

Branch `chore/db1-schema-lockin` off `origin/main` in `$CLOUD_REPO`. Generate Drizzle migrations in `packages/web/drizzle/`:

**New tables:**
- `agents` — the persona-level identity (see schema in A1)
- `persona_versions`
- `integration_scopes`
- `user_integrations` (if not already shipped — verify)
- `workspace_integrations` (if not already shipped — absorb `workspace_service_accounts` if it exists)
- `workforce_cli_auth_sessions`

**Renames:**
- `cli_auth_sessions` → `cloud_cli_bootstrap_sessions`

**Repurpose `agent_deployments`:** the existing table moves from "persona-level deployment" semantics to "per-instance run" semantics. This is largely additive: keep `agent_deployments.id` as the per-instance ID; move persona-level columns (deployed_name, credential_selections, input_values, status, destroyed_at, etc.) to the new `agents` table. Add:
- `agent_deployments.agent_id uuid NOT NULL FK→agents(id)`
- `agent_deployments.trigger_kind text NOT NULL DEFAULT 'inbox'` (back-fill for existing rows)
- `agent_deployments.trigger_payload jsonb NULL`
- `agent_deployments.started_at`, `last_active_at` timestamptz
- `agent_deployments.timed_out_at timestamptz NULL`
- `agent_deployments.compaction_summary text NULL`
- `agent_deployments.parent_deployment_id uuid NULL FK→agent_deployments(id)`
- `agent_deployments.spec_hash_at_run text`
- `agent_deployments.status` enum updated to `running | idle | timed_out | completed | failed`

**Back-fill migration for existing `agent_deployments` rows:** for each existing row:
1. Create an `agents` row, copy persona-level columns.
2. Point the original row's new `agent_id` at it.
3. Translate the old status enum (`active | disabled | error | destroyed`) → new statuses (`running | timed_out | failed | completed`) using a best-effort mapping (active→running, disabled→completed, error→failed, destroyed→completed with destroyed_at copied to agents).

**Column adds on existing tables:**
- `user_integrations.adapter text NOT NULL DEFAULT 'nango'`
- `workspace_integrations.adapter text NOT NULL DEFAULT 'nango'`

**Data migrations:**
- `slack_channel_configs` → `integration_scopes` with `scope_kind = 'slack_channel'`. After move, drop `slack_channel_configs`.
- `workspace_service_accounts` → `workspace_integrations` with `name = <service-account-name>`. After move, drop `workspace_service_accounts`.

**Constraint updates:**
- `agents` unique indexes filtered `WHERE status != 'destroyed'`.

**Codegen:**
- Run Drizzle codegen so the TypeScript schema (`packages/web/lib/db/schema.ts`) matches.

### Track A acceptance

- [ ] Issue body of cloud#553 reflects every bullet above.
- [ ] `agents` table created; `agent_deployments` repurposed for per-instance rows.
- [ ] All migrations + back-fill steps land in the same PR.
- [ ] Migrations PR opens as DRAFT.
- [ ] `npm run typecheck` clean.
- [ ] `npm test` passes (existing tests; new tables not yet exercised — that's Track B).
- [ ] No `--no-verify`; all hooks pass.

**Effort estimate:** ~5h (back-fill migration is the bulk of the work).

---

## Track B — Cloud resolver: dispatch on `source` + `adapter`

**Repo:** `$CLOUD_REPO.wt-resolver` (worktree)
**Implementer model:** codex (medium reasoning).
**Working branch:** `feat/integration-resolver-source-dispatch`
**Base:** Track A's branch (or `main` if Track A merges first).
**Depends on:** Track A's migrations PR merged (or mergeable + schema types stable).

**Allowed-dirty regex:** `packages/web/lib/integrations/.*|packages/web/lib/proactive-runtime/deploy-manager\.ts|packages/web/app/api/v1/integrations/.*`

### Implementation

Update cloud's integration resolver (find it under `packages/web/lib/integrations/` and `packages/web/lib/proactive-runtime/deploy-manager.ts`).

1. **Read `source` from persona spec.** Persona-side `PersonaIntegrationConfig.source` ships in workforce#97 (rebased in Track E5). For each declared integration:
   - `source.kind === 'deployer_user'` → query `user_integrations WHERE user_id = $deployer AND provider = $p AND name IS NULL`.
   - `source.kind === 'workspace'` → query `workspace_integrations WHERE workspace_id = $ws AND provider = $p AND name IS NULL`.
   - `source.kind === 'workspace_service_account'` → query `workspace_integrations WHERE workspace_id = $ws AND provider = $p AND name = $source.name`.
   - Missing/undefined `source` → default `{ kind: 'deployer_user' }`. Mirror persona-kit's parser default-injection.

2. **GitHub App combine.** When provider is `github` AND `source.kind === 'deployer_user'`, ALSO load the workspace's `workspace_integrations` row (`name IS NULL`) for the installation_id. Return a combined resolved-integration object:
   ```ts
   { user_oauth: UserIntegrationRow, workspace_install: WorkspaceIntegrationRow }
   ```
   If the workspace install is missing, deploy must fail with: `GitHub deploys require both a user OAuth and a workspace GitHub App install. Workspace install missing.`

3. **`adapter` dispatch.** When invoking the connection's token-refresh / introspection logic, branch on `integration.adapter`:
   - `'nango'` → existing Nango path (unchanged).
   - `'composio'` → existing Composio path in `packages/web/lib/integrations/composio-service.ts`.
   - `'pipedream'` → throw `Adapter 'pipedream' not yet wired` (stub for future).

4. **Default `source` injection on the cloud side.** Mirror persona-kit's behavior: any spec arriving without `source` gets `{ kind: 'deployer_user' }` injected at resolver entry.

### Track B tests

Add resolver test fixtures (vitest):
- [ ] deployer_user happy path
- [ ] workspace happy path
- [ ] workspace_service_account happy path (named)
- [ ] GitHub combine: both rows present → success
- [ ] GitHub combine: workspace install missing → clear error
- [ ] Missing user_integrations row → clear error
- [ ] Unknown `adapter` → clean "not yet wired" error
- [ ] Default source injection when persona spec omits it
- [ ] Adapter dispatch routes correctly (Nango / Composio)

### Track B acceptance

- [ ] Resolver dispatches by `source.kind` without inference.
- [ ] GitHub combine returns both rows when both required.
- [ ] Adapter dispatch routes to existing Nango + Composio paths.
- [ ] All new tests green; existing tests unchanged.
- [ ] `npm run typecheck && npm test` clean.

**Effort estimate:** ~4h.

---

## Track C — Cloud #548 OSS-scope rebase coordination

**Repo:** `$CLOUD_REPO` (no worktree — comment-only)
**Implementer model:** claude (medium reasoning).
**No branch.** Comment-only via `gh pr comment`.

**Note:** relay#844 already merged at 2026-05-12T19:50:04Z. `@agent-relay/events@6.0.17` and `@agent-relay/agent@6.0.17` are published on npm. A coordination comment has already been posted on cloud#548 (see comment `4434762449`). Track C is effectively **already done** at workflow start; Ricky should verify the comment exists and skip if so.

### Preflight

```bash
COMMENT_EXISTS=$(gh pr view 548 --repo AgentWorkforce/cloud --json comments \
  -q '.comments[] | select(.body | test("@agent-relay/events@6\\.0\\.17")) | .id' | head -1)

if [ -n "$COMMENT_EXISTS" ]; then
  echo "SKIP: Track C already posted via comment $COMMENT_EXISTS"
  exit 0
fi
```

If somehow the comment is missing (rolled back, etc.), re-post it:

```bash
gh pr comment 548 --repo AgentWorkforce/cloud -F <body-file.md>
```

with the same contents as comment `4434762449` (relay#844 merged, versions live, rebase recommendation, alternative cleanup-PR option).

### Track C acceptance

- [ ] Coordination comment exists on cloud#548 referencing `@agent-relay/{events,agent}@6.0.17`.

**Effort estimate:** ~5min.

---

## Track D — Workforce persona-kit refactor (traits-out, sandbox-out, listeners doc)

**Repo:** `$WORKFORCE_REPO` (operates in place — Track D owns the primary checkout; E/F use worktrees)
**Implementer model:** codex (high reasoning).
**Working branch:** `refactor/persona-kit-schema-lockin`
**Base:** `origin/main` AFTER workforce#95 merges.

**Hard precondition:**
```bash
MERGED_AT=$(gh pr view 95 --repo AgentWorkforce/workforce --json mergedAt -q '.mergedAt')
if [ -z "$MERGED_AT" ] || [ "$MERGED_AT" = "null" ]; then
  echo "WAITING: workforce#95 not merged"; exit 0
fi
```

**Allowed-dirty regex:** `packages/persona-kit/.*|packages/runtime/src/proactive\.ts|packages/runtime/src/types\.ts|packages/runtime/src/ctx\.ts|packages/deploy/src/.*|examples/.*|docs/plans/.*`

### Implementation

1. **Remove `traits` from `PersonaSpec`.**
   - Delete `Traits` type from `packages/persona-kit/src/types.ts`.
   - Delete `spec.traits` parsing logic from `packages/persona-kit/src/parse.ts`.
   - Update all persona fixtures in `packages/persona-kit/src/__fixtures__/` and `examples/*/persona.json` to remove any `traits` block.
   - Remove `traits`-related re-exports / imports from `packages/runtime/src/proactive.ts`. If `expressionFromTraits` (or similar) is still referenced, remove it.
   - Parser must REJECT personas containing a `traits` key with a clear error: `traits was removed in v1; personality is handled by the persona-personality-builder tool (out of scope for v1). See docs/plans/deploy-v1.md`.

2. **Remove `sandbox` from `PersonaSpec`.**
   - Delete `SandboxConfig` type and `spec.sandbox` parsing.
   - Update fixtures and examples removing any `sandbox` blocks.
   - Verify `@agentworkforce/deploy` (`packages/deploy/src/index.ts` and `packages/deploy/src/modes/sandbox.ts`) reads sandbox config from deploy options (the `--mode sandbox` CLI flag and any defaults baked into the deploy package), NOT from `persona.spec`. If any code reads `spec.sandbox`, refactor.
   - Parser must REJECT personas containing a `sandbox` key with a clear error: `sandbox was removed in v1; sandbox is on by default at deploy time. Use 'workforce deploy --no-sandbox' or runtime config to opt out. See docs/plans/deploy-v1.md`.

3. **Listeners section rename (DOCS + COMMENTS ONLY — keep current SHAPE).**
   Khaliq explicitly: "I don't know if we have to be so literal with inbox, clock, radio, current shape is probably fine, but can use listeners."
   - Add JSDoc comments on `PersonaIntegrationConfig` and `Schedule` describing them as the "radio listener" and "clock listener" parts of a persona's listener surface.
   - Top-level JSDoc on `PersonaSpec`:
     > A persona listens for events. Three listener kinds: **clock** (cron schedules — `schedules[]`), **radio** (RelayFile integration events — `integrations.<provider>.triggers[]`), **inbox** (RelayCast targeted messages — not yet modeled in v1). The current shape predates the listeners framing; semantics are equivalent.
   - Update `docs/plans/deploy-v1.md` §3 prose with the listeners narrative (recover from git if untracked: `git show 11ed713:docs/plans/deploy-v1.md > docs/plans/deploy-v1.md`).
   - Do NOT restructure JSON schema. Do NOT rename existing types.

4. **Regenerate persona JSON schema if applicable.**
   - If `packages/persona-kit/scripts/emit-schema.mjs` exists on the branch: run it, commit the regenerated `packages/persona-kit/schemas/persona.schema.json`.
   - If not, skip and note in PR body that #94 will pick it up on rebase.

5. **Update tests.**
   - Remove tests asserting on `traits`/`sandbox` fields.
   - Add tests asserting parse FAILURE (with the specific error messages) when `traits` or `sandbox` keys appear.
   - Verify the 14 personas in `packages/personas-core` still validate via `corepack pnpm -r --filter @agentworkforce/personas-core run lint`.

6. **Examples cleanup.** Strip `traits` + `sandbox` from `examples/weekly-digest/persona.json`, `examples/review-agent/persona.json`, `examples/linear-shipper/persona.json` if they exist on this branch.

### Track D acceptance

- [ ] `traits` and `sandbox` types removed from persona-kit `types.ts` and `parse.ts`.
- [ ] Parser rejects `traits` and `sandbox` with the specified errors.
- [ ] All persona fixtures + 14 core personas parse without errors.
- [ ] Listeners JSDoc + `deploy-v1.md` §3 narrative updated.
- [ ] Persona JSON schema regenerated if emit-schema is on the branch.
- [ ] `corepack pnpm -r run build && corepack pnpm run typecheck && corepack pnpm -r run test` green.
- [ ] PR opens as DRAFT.

**Effort estimate:** ~2.5h.

---

## Track E — Workforce queue rebase (#92, #93, #94, #96, #97)

**Repo:** `$WORKFORCE_REPO.wt-rebase-<N>` (one worktree per PR)
**Implementer model:** codex (medium reasoning).
**Depends on:** Track D merged.

For each PR in the workforce queue, rebase its branch onto post-Track-D `main`. Resolve conflicts from traits/sandbox removal. Do NOT introduce new functionality. Push with `git push --force-with-lease`.

### Sub-tracks

| ID | PR | Branch | Worktree | Rebase action |
|---|---|---|---|---|
| **E1** | #92 | `feat/integrations-vfs` | `wt-rebase-92` | Rebase. VFS substrate doesn't touch traits/sandbox; conflicts should be minimal. |
| **E2** | #93 | `feat/integrations-vfs-examples` | `wt-rebase-93` | Rebase + strip `traits` and `sandbox` blocks from `examples/review-agent/persona.json` and `examples/linear-shipper/persona.json`. Verify both still type-check against #92's `WorkforceCtx`. |
| **E3** | #94 | `feat/persona-json-schema` | `wt-rebase-94` | Rebase + run `scripts/emit-schema.mjs` to regenerate `packages/persona-kit/schemas/persona.schema.json`. Verify fixtures still validate. |
| **E4** | #96 | `feat/proactive-bridge` | `wt-rebase-96` | Rebase. Drop any remaining `expressionFromTraits` references. Bump `@agent-assistant/proactive ^0.4.31 → ^0.4.32` per agent-assistant#91 publish; run `corepack pnpm install` to refresh `pnpm-lock.yaml`. Verify the existing test baseline passes. |
| **E5** | #97 | `feat/persona-integration-source` | `wt-rebase-97` | Rebase. Interface name is `PersonaIntegrationConfig` (verified in #97). No content change beyond rebase. |

### Per-sub-track gates (soft → fixer → hard)

```bash
corepack pnpm -r run build
corepack pnpm run typecheck
corepack pnpm -r run test
```

### Track E acceptance (per sub-track)

- [ ] Rebased branch pushes successfully with `--force-with-lease`.
- [ ] CI on the PR is green after rebase.
- [ ] No functional regression vs the PR's original acceptance bullets.
- [ ] If conflicts unresolvable: open `<original-branch>-rebased`, post a comment on the original linking it, STOP that sub-track. Others continue.

**Effort estimate:** ~1h per sub-track; E1–E5 can run in parallel after Track D.

---

## Track F — Workforce runtime input-values + agent identity wiring

**Repo:** `$WORKFORCE_REPO.wt-runtime` (worktree)
**Implementer model:** codex (medium reasoning).
**Working branch:** `feat/runtime-input-values-resolution`
**Base:** post-Track-D `main`.
**Depends on:** Track D merged AND Track A's migrations PR merged (need `agents.input_values` column).

**Allowed-dirty regex:** `packages/runtime/src/ctx\.ts|packages/runtime/src/types\.ts|packages/runtime/src/ctx\.test\.ts|packages/runtime/src/__tests__/.*`

### Implementation

In `packages/runtime/src/ctx.ts`:

1. **Read `input_values` from the `agents` row** (NOT `agent_deployments` — input values are agent-level, not per-instance).
   ```
   resolved[key] = agents.input_values[key] ?? persona.spec.inputs[key].default
   ```
   When a required input has no value from either source, throw before the handler runs:
   ```
   Required input '<key>' has no value (no deployment override, no spec default). Set it via 'workforce deploy --input <key>=<value>' or by editing the agent record.
   ```

2. **Update `WorkforceCtx.persona.inputs` shape** (`types.ts`):
   - Currently exposes `Record<string, PersonaInputSpec>` (defaults).
   - New: expose `Record<string, string>` (resolved values).
   - Add `ctx.persona.inputSpecs: Record<string, PersonaInputSpec>` for consumers that need the spec.

3. **Add `ctx.agent` and `ctx.deployment` accessors** to mirror the schema:
   ```ts
   ctx.agent: { id: string; deployedName: string; spawnedByAgentId: string | null; ... }
   ctx.deployment: { id: string; triggerKind: 'inbox' | 'clock' | 'radio'; parentDeploymentId: string | null; ... }
   ```
   The runtime injects these from the agent + agent_deployment rows that fired this handler.

4. **Tests:**
   - [ ] Override wins over default.
   - [ ] Default fills when override absent.
   - [ ] Required input with no value → throws specified error.
   - [ ] `ctx.persona.inputSpecs` still exposes the spec defaults.
   - [ ] `ctx.agent.id` + `ctx.deployment.id` correctly populated.

### Track F acceptance

- [ ] `ctx.persona.inputs` returns resolved values.
- [ ] Required-but-missing inputs throw with the specified error.
- [ ] `ctx.persona.inputSpecs` accessor added.
- [ ] `ctx.agent` and `ctx.deployment` accessors added.
- [ ] `corepack pnpm -r run build && corepack pnpm -r run test` green.
- [ ] PR title: `feat(runtime): resolve persona inputs from agents.input_values + expose ctx.agent/ctx.deployment`
- [ ] Opens as DRAFT.

**Effort estimate:** ~2h.

---

---

# Phase 2 — Deploy enablement tracks

Phase 1 (Tracks A–F) lands the schema, persona-kit refactor, runtime accessors, and queue rebase. **Phase 2 lights up end-to-end deploy** — cloud accepts a persona+bundle payload, workforce CLI speaks that contract OSS-generically, deploy-time inputs are wired, and the MCP `workflow.run` tool actually returns results.

Phase 2 tracks depend on Phase 1 tracks being merged. Order: G → H (workforce-side consumer of G's contract); I depends on A (schema) + D (persona-kit); J depends on cloud#555 being live on main.

## Track G — Cloud persona+bundle deploy endpoint

**Repo:** `$CLOUD_REPO.wt-deploy-endpoint` (worktree)
**Implementer model:** codex (high reasoning).
**Working branch:** `feat/persona-bundle-deploy-endpoint`
**Base:** Track A merged (`agents` + `agent_deployments` schema live); cloud#548 ideally merged (for agent-gateway + DO infra) but the endpoint can ship as a stub that queues for the gateway if #548 is still in flight.

**Depends on:**
- Track A merged.
- cloud#548 merged (for agent-gateway DO + `relaycron-client.ts` + `registerWatches` infra).
- **relaycron#5 merged** — without this, the WS-delivery + cancel API in relaycron isn't live, and schedule registration via cloud's `relaycron-client.ts` returns errors at runtime. Preflight check:
  ```bash
  RC5_MERGED=$(gh pr view 5 --repo AgentWorkforce/relaycron --json mergedAt -q '.mergedAt')
  if [ -z "$RC5_MERGED" ] || [ "$RC5_MERGED" = "null" ]; then
    echo "WAITING: relaycron#5 not merged"; exit 0
  fi
  ```

**Allowed-dirty regex:** `packages/web/app/api/v1/workspaces/\[workspaceId\]/deployments/.*|packages/web/lib/proactive-runtime/.*|packages/web/lib/.*persona.*|services/agent-gateway/.*`

### Why this exists

cloud#548's `/api/v1/deploy` takes `{ entrypoint, source }` — single-file TS. workforce's deploy CLI is built to upload a persona+bundle. The decision (Khaliq): **cloud adds a new endpoint for the persona+bundle contract.** Single-file `/api/v1/deploy` stays for power users; persona+bundle is the workforce-CLI surface.

### Endpoint contract

```
POST /api/v1/workspaces/:workspaceId/deployments
Auth: workspace token (mirror sandbox endpoint auth scopes)
Body:
{
  persona: PersonaSpec,                 // full persona JSON, validated via @agentworkforce/persona-kit
  bundle: {
    runner: string,                     // contents of runner.mjs
    agent: string,                      // contents of agent.bundle.mjs (esbuild output)
    packageJson: object                 // contents of package.json
  },
  inputs?: Record<string, string>,      // initial input values for agents.input_values
  pinnedVersion?: { version: number }   // optional; if set, pin to that persona_versions row
}
Returns 201:
{
  agentId: string,                      // agents.id
  workspaceId: string,
  status: 'starting' | 'active' | 'failed',
  deploymentId: string                  // first agent_deployments row created at boot
}
```

### Implementation

1. **Validate** `persona` via `@agentworkforce/persona-kit`'s `parsePersonaSpec`. Fail with field-pointed errors on schema problems.

2. **Persist `persona_versions` row.** Compute `spec_hash`; insert a new `persona_versions` row if no existing row matches (`UNIQUE (persona_id, spec_hash)`). Set `pinned_version_id` on the agent row to this new version.

3. **Upsert `agents` row.** Match on `(workspace_id, persona_id)` where `status != 'destroyed'`:
   - If exists → update `pinned_version_id`, `input_values`, `spec_hash_at_deploy`, bump `last_used_at`.
   - If not → insert new row with `status='active'`.

4. **Translate `persona.integrations.<provider>.triggers[]` → watch glob list.** The convention the agent-gateway DO and `@agent-relay/agent`'s `registerWatches` expect is glob paths under provider namespaces (e.g. `/github/pull_requests/**`). Read `services/agent-gateway/src/durable-object.ts` + `packages/agent-relay-agent/src/index.ts` to confirm the exact glob format. Translation rule:

   ```
   provider=github, trigger.on='pull_request.opened'  →  /github/pull_requests/opened/**
   provider=linear, trigger.on='issue.created'        →  /linear/issues/created/**
   provider=slack,  trigger.on='app_mention'          →  /slack/app_mention/**
   ```

   Build a lookup table from RelayFile adapter docs (`relayfile-adapters/packages/*/docs/` if present). For unknown provider/trigger combinations, fail deploy with a clear error.

5. **Persist watch globs** on the `agents` row OR in a sidecar — depends on how cloud#548's deploy-manager stores them. Most likely: store on `agents.watch_globs text[] NULL` (add to Track A if not already there) so the agent-gateway can pull them at agent boot. **Update Track A's migrations to add this column.**

6. **Translate `persona.schedules[]` → relaycron registrations.** Call `services/agent-gateway/src/relaycron-client.ts:registerCronSchedules()` with each schedule, scoped by `agentId`. Persist returned `gatewayScheduleId`s on `agents.schedule_ids text[]` (add to Track A migrations).

7. **Provision Daytona sandbox + upload bundle.** Use the existing `POST /api/v1/workspaces/:id/sandboxes` (cloud#543) infrastructure. Write the bundle files (`runner.mjs`, `agent.bundle.mjs`, `persona.json`, `package.json`) to the sandbox via the existing files-proxy route.

8. **Start the runner.** Call the sandbox's exec route with `node runner.mjs`. The runner internally calls `agent({...})` which calls `registerWatches` against the gateway, completing the watch subscription.

9. **Insert initial `agent_deployments` row** with `status='running'`, `trigger_kind='inbox'` (or the trigger that launched it), `started_at=now`.

10. **Audit-log** every deployment creation (mirror sandbox endpoint audit pattern).

### Track G tests

- [ ] Happy path: valid persona+bundle → 201 with agentId
- [ ] Re-deploy same persona → agentId stable; persona_versions has new row only if spec_hash differs
- [ ] Invalid persona (e.g. has `traits`) → 400 with field-pointed error
- [ ] Trigger translation: known github/linear/slack/notion/jira triggers map correctly
- [ ] Unknown trigger → 400 with clear error
- [ ] Cron schedules registered with relaycron (mock relaycron client)
- [ ] Daytona sandbox creation + bundle upload happen in order
- [ ] Auth: missing workspace token → 401; wrong scope → 403

### Track G acceptance

- [ ] Endpoint added at `POST /api/v1/workspaces/:workspaceId/deployments`.
- [ ] Persona validation, version persistence, agent upsert, trigger translation, schedule registration all wired.
- [ ] Sandbox provisioning + bundle upload + runner start work end-to-end against a test workspace.
- [ ] All new tests green; no regressions on cloud#548's existing `/api/v1/deploy` endpoint.
- [ ] PR opens as DRAFT.
- [ ] Required Track A schema additions (`agents.watch_globs`, `agents.schedule_ids`) included in Track A's migration PR.

**Effort estimate:** ~6h.

---

## Track H — Workforce `--mode cloud` (OSS-generic implementation)

**Repo:** `$WORKFORCE_REPO.wt-mode-cloud` (worktree)
**Implementer model:** codex (medium reasoning).
**Working branch:** `feat/deploy-mode-cloud`
**Base:** post-Track-D `main` (after persona-kit refactor).
**Depends on:** Track D merged. Track G's endpoint contract STABLE (need not be merged on cloud; can stub against the spec).

**Allowed-dirty regex:** `packages/deploy/src/modes/cloud\.ts|packages/deploy/src/index\.ts|packages/deploy/src/login\.ts|packages/cli/src/cli\.ts`

### OSS / cloud split rationale

The workforce deploy CLI is OSS. Anyone running a workforce-compatible runtime (their own AWS, on-prem, anything) speaks the **persona+bundle contract** with whatever cloud endpoint URL is configured. The deploy CLI does NOT bake in `agentrelay.com`. The CLI ships generic; cloud (the proprietary side) implements the endpoint.

- **workforce (OSS)** — Track H: this track. Replace the stubbed `packages/deploy/src/modes/cloud.ts` with a real implementation that POSTs persona+bundle to a configurable cloud-deploy URL.
- **cloud (proprietary)** — Track G: cloud-specific endpoint implementation (above).

### Decision-tree mapping (image 2)

Track H implements the full deploy decision tree from image 2 of the May 12 whimsical diagram. Each step in the tree maps to a stage in the CLI flow:

```
agentworkforce deploy <persona-path>
  │
  ├─► STAGE 1: Choose runtime
  │     ├─ --cloud-url flag         → use that
  │     ├─ WORKFORCE_CLOUD_URL env  → use that
  │     ├─ persona.cloud.deployUrl  → use that
  │     └─ default                  → https://agentrelay.com  (note: "build your own" docs link printed when default is overridden)
  │
  ├─► STAGE 2: Logged in?
  │     ├─ no   → open browser to <cloudUrl>/cli-auth (relayauth PKCE flow)
  │     │         save returned token to OS keychain
  │     └─ yes  → use token saved on machine
  │
  ├─► STAGE 3: Harness availability check
  │     For each harness the persona declares (claude/codex/opencode):
  │     Query GET <cloudUrl>/api/v1/users/me/provider_credentials?model_provider=<derived>
  │     ├─ have a connected credential → continue
  │     └─ none →
  │           Prompt: "Do you want to set up your harness's subscription? (Y/n)"
  │           ├─ yes → trigger provider_oauth flow (existing /provider_credentials/auth-session endpoint)
  │           └─ no  →
  │                  Prompt: "AgentRelay plan or BYOK?"
  │                  ├─ plan → set auth_type='relay_managed' (cloud uses its key, tracks spend, charges markup)
  │                  └─ BYOK → prompt for API key; save encrypted via cloud /provider_credentials POST (auth_type='byo_api_key')
  │
  ├─► STAGE 4: Review listeners, determine required integrations
  │     For each persona.integrations.<provider>:
  │     Query GET <cloudUrl>/api/v1/workspaces/:id/integrations?provider=<p>
  │     ├─ connected → continue
  │     └─ missing  → open browser to <cloudUrl>/integrations?provider=<p>&workspace=<id>&return_to=<cli-callback>
  │                  block until OAuth callback completes
  │
  ├─► STAGE 5: Persona exists?
  │     Query GET <cloudUrl>/api/v1/workspaces/:id/agents?persona_slug=<persona.id>
  │     ├─ no   → continue to deploy
  │     └─ yes  →
  │           Prompt: "This persona is already deployed as agent <agentId> (status: <status>).
  │                    Update existing, destroy and create new, or cancel?"
  │           ├─ update    → continue to deploy (UNIQUE constraint will UPSERT)
  │           ├─ destroy   → POST <cloudUrl>/api/v1/workspaces/:id/agents/:agentId/destroy (M3 endpoint, may not be wired — if missing, exit with "destroy not yet wired; cancel and run with --force-replace later")
  │           └─ cancel    → exit 0
  │
  └─► STAGE 6: POST persona+bundle to Track G's endpoint
        See implementation below.
```

For non-interactive use (CI / scripts), the CLI accepts flag overrides for every interactive prompt:
- `--no-prompt` — fail fast on any decision that would normally prompt (instead of asking).
- `--harness-source plan|byok|oauth` — pre-answer Stage 3 decisions.
- `--byok-key <key>` — pre-answer BYOK prompt.
- `--on-exists update|destroy|cancel` — pre-answer Stage 5 decision (default: `cancel`).

### Implementation

In `packages/deploy/src/modes/cloud.ts`:

1. **Resolve cloud-deploy URL** as Stage 1 above.

2. **Load workspace token** from keychain via `packages/deploy/src/login.ts` (the relayauth PKCE flow already shipped in workforce#90). If absent and not `--no-prompt`, trigger login as Stage 2.

3. **Run Stages 3-5** with the prompt logic above (or flag overrides for non-interactive mode).

4. **POST persona+bundle (Stage 6):**
   ```ts
   const res = await fetch(`${cloudUrl}/api/v1/workspaces/${workspaceId}/deployments`, {
     method: 'POST',
     headers: {
       authorization: `Bearer ${workspaceToken}`,
       'content-type': 'application/json',
     },
     body: JSON.stringify({
       persona,
       bundle: {
         runner: await fs.readFile(bundle.runnerPath, 'utf8'),
         agent: await fs.readFile(bundle.bundlePath, 'utf8'),
         packageJson: JSON.parse(await fs.readFile(bundle.packageJsonPath, 'utf8')),
       },
       inputs: input.inputs,        // populated by Track I's --input flags
     }),
   });
   if (!res.ok) throw new Error(`Cloud deploy failed: ${res.status} ${await res.text()}`);
   const { agentId, status, deploymentId } = await res.json();
   ```

5. **Status polling.** After POST returns `status: 'starting'`, poll `GET /api/v1/workspaces/:id/agents/:agentId` until `status='active'` or `'failed'` (60s timeout). Stream updates via `onLog`.

6. **Return a `CloudRunHandle`** that exposes `{ agentId, stop(): Promise<void>, done: Promise<...> }`. `stop()` calls the M3 destroy endpoint; if not wired, throw cleanly.

7. **Remove the "not yet available" stub** from `packages/deploy/src/index.ts`.

8. **Add the `--cloud-url`, `--no-prompt`, `--harness-source`, `--byok-key`, `--on-exists` CLI flags** to `packages/cli/src/cli.ts`'s `deploy` case.

### Track H tests

- [ ] Happy path: persona + bundle POST → returns CloudRunHandle with agentId.
- [ ] Cloud URL override via flag, env, persona field, default — precedence tested.
- [ ] 401 from cloud → clean error suggesting `workforce login`.
- [ ] Network error → retry with backoff (3 attempts).
- [ ] Status polling resolves on `active` and `failed`.
- [ ] `stop()` calls DELETE endpoint.

### Track H acceptance

- [ ] `workforce deploy --mode cloud` no longer prints "not yet available."
- [ ] Posts to the configured cloud URL with persona+bundle contract.
- [ ] OSS-generic: no `agentrelay.com` baked into code paths (only as a default URL).
- [ ] PR opens as DRAFT.

**Effort estimate:** ~3h.

---

## Track I — Deploy CLI `--input <key>=<value>` flags

**Repo:** `$WORKFORCE_REPO.wt-deploy-inputs` (worktree)
**Implementer model:** codex (medium reasoning).
**Working branch:** `feat/deploy-input-flags`
**Base:** post-Track-D `main`.
**Depends on:** Track D merged. Track A merged (need `agents.input_values` column). Track F merged (runtime reads from `input_values`).

**Allowed-dirty regex:** `packages/cli/src/cli\.ts|packages/deploy/src/index\.ts|packages/deploy/src/types\.ts|packages/deploy/src/modes/.*`

### Implementation

1. **Accept `--input <key>=<value>` flag in `packages/cli/src/cli.ts`** (repeatable). Parse into `Record<string, string>`. Reject malformed flags with a clear error.

2. **Plumb through `packages/deploy/src/index.ts`'s `deploy()` function** as `DeployOptions.inputs?: Record<string, string>`.

3. **Validate against persona spec at deploy time.** For each provided input key:
   - Must be declared in `persona.spec.inputs` — else fail with `Unknown input '<key>'; persona declares: <list>`.
   - Value must be a string (basic type check; persona-kit may add more later).

4. **Forward to each mode:**
   - `--mode dev`: pass as env vars to the spawned child process (`WORKFORCE_INPUT_<KEY>=<value>`).
   - `--mode sandbox`: pass as env vars to the Daytona sandbox (`envVars` arg).
   - `--mode cloud`: include in the POST body's `inputs` field (Track H consumes this).

5. **Update persona spec docs in `docs/plans/deploy-v1.md` §3** to mention `--input` as the deploy-time override mechanism.

### Track I tests

- [ ] Single `--input` parses and forwards.
- [ ] Multiple `--input` flags accumulate.
- [ ] Malformed flag (`--input foo`) → clean error.
- [ ] Undeclared input key → clean error citing persona's declared inputs.
- [ ] `--mode dev` env vars actually reach the child process.
- [ ] `--mode cloud` POST body includes the `inputs` field.

### Track I acceptance

- [ ] `workforce deploy --input topic=AI --input region=us-east-1 ./persona.json` works against all three modes.
- [ ] Undeclared inputs fail fast with a clear error.
- [ ] PR opens as DRAFT.

**Effort estimate:** ~1.5h.

---

## Track J — `workflow.run` MCP synthesis + scope mint (cloud#555 follow-ups)

**Repo:** `$CLOUD_REPO.wt-workflow-shim-followups` (worktree)
**Implementer model:** codex (high reasoning).
**Working branch:** `feat/workflow-invocations-followups`
**Base:** cloud#555 merged (the URL surface).
**Depends on:** cloud#555 merged.

**Allowed-dirty regex:** `packages/web/app/api/v1/workspaces/\[workspaceId\]/workflows/.*|packages/web/lib/workflows/.*|packages/web/lib/auth/.*sandbox.*`

### Why this exists

cloud#555 shipped `POST /api/v1/workspaces/:id/workflows/run` taking `{ name, args }`, but it returns 501 for any registered slug — because the heavy `/api/v1/workflows/run` requires `s3CodeKey`/`sourceFileType`/`runtime` fields that can't be derived from `{ name, args }`. Two follow-ups to actually light it up:

### J1 — Synthesis policy + named-workflow registry

Implement a slug → workflow translation in `packages/web/lib/workflows/invocation-registry.ts` (created in #555). Convention:

- **Named workflows live at a known S3 prefix.** Every named workflow has a pre-staged tarball at `s3://workflows/<slug>/latest.tar.gz` (or similar — match what the heavy workflow engine expects). The synthesis fills in `s3CodeKey: 'workflows/<slug>/latest.tar.gz'`.
- **`sourceFileType` defaults to `'workflow'`** unless the slug's registry entry overrides it.
- **`runtime` defaults to `{ id: 'daytona' }`** from the workspace's `default_runtime` column (the cloud-side dispatch target Will explained earlier).
- **`args`** from the MCP tool call is forwarded as `metadata.invocationArgs` to the heavy engine, since the heavy engine doesn't have a first-class args field.

Add an initial registry of named workflows. Start with one slug (e.g. `'echo'` — a minimal workflow that just echoes args back) so the round-trip can be smoke-tested.

Implementer should read the existing heavy `/api/v1/workflows/run/route.ts` to confirm the exact `RunRequestBody` synthesis. If a required field genuinely can't be synthesized, surface in PR body.

### J2 — Scope mint additions

The sandbox-token mint flow at `packages/web/app/api/v1/workflows/run/route.ts` currently mints `workflow:runs:read`, `workflow:logs:read`, `workflow:runs:events:write`. The MCP server expects to call the new lightweight endpoints, which require `workflow:invoke:write` (for `workflow.run`) and `workflow:invoke:read` (for `workflow.status`).

Add these scopes to the mint:
- `workflow:invoke:write` — minted on sandbox creation for any workspace running a proactive runtime agent.
- `workflow:invoke:read` — same.

Ensure `requireAuthScope` checks in the new `/workspaces/:id/workflows/run` and `/workspaces/:id/workflows/runs/:runId` routes accept these scopes.

### Track J tests

- [ ] J1: `POST /workspaces/:id/workflows/run` with `name='echo', args={foo:1}` returns a runId; the heavy engine receives a synthesized RunRequestBody.
- [ ] J1: Unknown slug → 404 with list of known slugs.
- [ ] J2: A sandbox token without `workflow:invoke:write` → 403 on POST.
- [ ] J2: Token with the right scope → success path.
- [ ] End-to-end: MCP `workflow.run` call from a Daytona sandbox actually returns a runId, no longer 501.

### Track J acceptance

- [ ] `workflow.run` MCP tool returns a real runId for at least one registered slug (`echo` is fine for v1).
- [ ] Scope mint includes the two new scopes for sandbox tokens.
- [ ] PR opens as DRAFT.
- [ ] cloud#555's `Status: Ready for Review` note updated to reflect that J1+J2 lit it up.

**Effort estimate:** ~3.5h.

---

## Acceptance contract (workflow-level)

After ALL tracks (Phase 1 + Phase 2) complete:

### Phase 1
1. cloud#553 issue body reflects every lock-in (Track A1).
2. Cloud migrations PR (Track A2) is open as DRAFT, CI green; `agents` table created, `agent_deployments` repurposed for per-instance rows.
3. Cloud resolver PR (Track B) is open as DRAFT, CI green; dispatches on `source` + `adapter`.
4. cloud#548 has the relay#844 coordination comment (Track C — already posted).
5. Workforce persona-kit PR (Track D) is open as DRAFT, CI green; traits + sandbox removed.
6. Workforce queue (#92, #93, #94, #96, #97) is all rebased + green.
7. Workforce runtime PR (Track F) is open as DRAFT, CI green; ctx.agent + ctx.deployment + resolved inputs.

### Phase 2
8. Cloud persona+bundle endpoint PR (Track G) is open as DRAFT, CI green; validates persona, persists version, upserts agent, registers schedules, translates triggers, provisions sandbox.
9. Workforce `--mode cloud` PR (Track H) is open as DRAFT, CI green; speaks Track G's contract OSS-generically.
10. Workforce `--input` flags PR (Track I) is open as DRAFT, CI green; flows through all three modes.
11. Workflow-invocations follow-ups PR (Track J) is open as DRAFT, CI green; `workflow.run` MCP tool returns real runIds.

### Loud holes after this workflow

- ⚠️ **Memory is not wired.** `ctx.memory` is a stub. Follow-up workflow needed.
- ⚠️ **M3 destroy/list CLI commands** not implemented. Out of scope; M3 milestone workflow.
- ⚠️ **`@workforce/daytona-runner` not on npm** under `@workforce` scope. Handled by a separate agent per platform-team OIDC setup; not blocking morning state because cloud consumes via workspace ref.

---

## Track K — End-to-end smoke test

**Repo:** `$WORKFORCE_REPO.wt-smoke` (worktree)
**Implementer model:** codex (medium reasoning).
**Working branch:** `test/deploy-v1-e2e-smoke`
**Base:** post-everything-merged `main`.
**Depends on:** All Phase 1 + Phase 2 tracks merged. cloud#548 + relaycron#5 + relay#843 merged.

**Allowed-dirty regex:** `packages/deploy/test/e2e/.*|\.github/workflows/deploy-e2e\.yml`

### Why this exists

When Khaliq wakes up, the workflow should have proved that everything actually works end-to-end, not just compiled. This track runs a real deploy against staging cloud and asserts the agent fires on a real trigger.

### Implementation

Add `packages/deploy/test/e2e/weekly-digest.smoke.test.ts`:

1. **Build the bundle locally** for `examples/weekly-digest/persona.json`:
   ```ts
   const bundle = await stageBundle({
     personaPath: path.resolve('examples/weekly-digest/persona.json'),
     persona: parsePersonaSpec(/* loaded */),
     outDir: '.workforce/build/smoke-weekly-digest',
   });
   ```

2. **Authenticate** using `WORKFORCE_E2E_STAGING_TOKEN` from env (CI secret). Skip the test gracefully if missing.

3. **Deploy via Track H's `--mode cloud`** against the staging cloud URL (`WORKFORCE_E2E_STAGING_URL`).

4. **Force a cron tick** by directly POSTing to the runtime test hook (`POST /api/v1/workspaces/:id/agents/:agentId/_test/tick`, mirror what cloud#548 exposes — if no hook, skip the trigger and assert deployment was created + status='active' instead).

5. **Assert** the agent posts a GitHub issue on the fixture repo `AgentWorkforce/deploy-e2e-fixtures` within 90s, with title pattern `Weekly digest — *`.

6. **Cleanup**: close the issue, optionally destroy the agent (skip if M3 destroy isn't wired).

7. **Add `.github/workflows/deploy-e2e.yml`** running this on nightly schedule + manual dispatch. Failures notify `#workforce-alerts`.

### Run during workflow

The workflow runs Track K's smoke test ONCE after all upstream tracks have merged — but does NOT block the cascade on it. The smoke test result is reported separately as `SMOKE_TEST: PASS` or `SMOKE_TEST: FAIL — see logs`. If it fails for environmental reasons (staging Daytona down, OAuth tokens missing, fixture repo unreachable), the workflow logs but doesn't unwind any merges.

### Track K acceptance

- [ ] Smoke test file added.
- [ ] Test passes when run against staging (or skipped cleanly if `WORKFORCE_E2E_STAGING_TOKEN` is unset).
- [ ] GitHub Actions workflow added.
- [ ] PR title: `test(deploy): e2e smoke for weekly-digest --mode cloud`.

**Effort estimate:** ~3h.

---

## Workforce PR queue triage (existing PRs the workflow handles)

The workflow operates on these existing workforce PRs in addition to the new tracks above. Each is either rebased + auto-merged in Track E, or explicitly skipped.

| PR | Branch | Track in this workflow | Auto-merge? |
|---|---|---|---|
| #97 | feat/persona-integration-source | Track E5 (rebase) | YES |
| #96 | feat/proactive-bridge | Track E4 (rebase + agent-assistant bump) | YES |
| #94 | feat/persona-json-schema | Track E3 (rebase + schema regen) | YES |
| #93 | feat/integrations-vfs-examples | Track E2 (rebase + strip traits/sandbox) | YES |
| #92 | feat/integrations-vfs | Track E1 (rebase) | YES |
| #91 | feat/mcp-workforce | Track E (rebase; stacks on #92) | YES |
| **#87** | feat/proactive-agent-builder-persona | NEW: auto-merge — contains `parseInputsShape` `optional: true` regression fix that Track F depends on; the new persona JSON is additive | YES (verify fix still in branch first) |
| **#89** | codex/deploy-v1-readme | NEW: AUTO-MERGE for docs alignment | YES (nice-to-have; merges if green) |

Open cloud PRs handled:

| PR | Handled by | Auto-merge? |
|---|---|---|
| cloud#548 | Verified for trigger registration; paired with relaycron#5 | YES (after architectural items resolved — see below) |
| cloud#551 | Phase 3 dispatcher, already unblocked | YES |
| cloud#554 | Daytona meter | NO — platform-team gates on meter name; flag for Khaliq |
| cloud#555 | Workflow-invocations shim; Track J adds follow-ups | Merge #555 first, then merge Track J's follow-ups on top |

Open chain-branch PRs:

| PR | Repo | Auto-merge? |
|---|---|---|
| relay#843 | relay | YES |
| relaycron#5 | relaycron | YES (pair with cloud#548) |
| relayauth#39 | relayauth | YES (docs-only, low risk) |

### cloud#548 special handling

cloud#548 still has my three architectural items unaddressed (deploy payload shape, URL scoping, OSS scope governance). Track C's coordination comment is posted. **The workflow's lead Claude must verify before auto-merging cloud#548**:

1. **Payload shape resolved.** Track G adds a new endpoint at `/api/v1/workspaces/:id/deployments` taking persona+bundle, separate from #548's `/api/v1/deploy` taking single-file. Both coexist. ✅ Resolved by Track G shipping in parallel.
2. **URL scoping** — #548 has top-level `/api/v1/deploy` while reads are workspace-scoped. Track G's new endpoint is workspace-scoped. The mixed shape is acceptable for v1 (legacy `/api/v1/deploy` deprecates later); proceed.
3. **OSS scope governance** — relay#844 merged, packages live. Once relay#843 merges too, the cleanup PR to remove cloud/packages/agent-relay-{events,agent} can land. **The workflow should land cloud#548 as-is** (with the OSS packages still in cloud), then run a follow-up cleanup PR (Track L below) that removes them and pins to `^6.0.17`.

---

## Track L — Cloud OSS-scope cleanup (post-#548 merge)

**Repo:** `$CLOUD_REPO.wt-oss-cleanup` (worktree)
**Implementer model:** codex (medium reasoning).
**Working branch:** `chore/remove-agent-relay-packages`
**Base:** post-cloud#548 + post-relay#843 merged `main`.

### Implementation

1. Delete `cloud/packages/agent-relay-events/` and `cloud/packages/agent-relay-agent/` directories.
2. Add `"@agent-relay/events": "^6.0.17"` and `"@agent-relay/agent": "^6.0.17"` to `services/agent-gateway/package.json` and any other consumer (verify via `grep -rln "agent-relay-events\|agent-relay-agent" services/ packages/`).
3. Refresh `package-lock.json` via `npm install`.
4. Run typecheck + tests; verify agent-gateway service still builds against the OSS packages.
5. PR title: `chore: remove in-tree @agent-relay/{events,agent}; consume from npm`.

**Auto-merge?** YES on gates green.

**Effort estimate:** ~1h.

---

## What Khaliq sees when waking up

After the workflow completes (assuming no aborts), morning state:

**Merged on `main`:**
- Workforce: #87 (with input fix), #91, #92, #93, #94, #96, #97, plus 6 new Track D/F/H/I/K branches, plus #89 README (optional).
- Cloud: #548, #551, #555, plus 5 new Track A/B/G/J/L branches.
- Relay: #843.
- Relaycron: #5.
- Relayauth: #39.

**Open (intentional holds):**
- cloud#554 (Daytona meter — platform-team gates).
- Anything from "Out of scope" list.

**Ready for testing:**
- ✅ `workforce deploy ./examples/weekly-digest/persona.json --mode cloud` should work end-to-end against staging.
- ✅ Cloud deploy endpoint accepts persona+bundle.
- ✅ Schedules registered with relaycron; watches registered at agent startup with gateway DO.
- ✅ Sandbox provisions; runner executes; handler runs.
- ⚠️ Memory calls no-op (stub).
- ⚠️ Workflow.run MCP tool returns runIds for registered slugs (Track J's `echo` registered as proof-of-life).

**Smoke test result** in workflow log:
- `SMOKE_TEST: PASS` — weekly-digest deployed against staging; cron tick posted GitHub issue within 90s.
- OR `SMOKE_TEST: FAIL — <reason>` with logs.

**Loud holes (documented in every track PR body):**
- ⚠️ Memory not wired (`ctx.memory` is a stub).
- ⚠️ M3 destroy/list commands missing.

**What Khaliq does in the morning:**
1. Read the workflow's final summary comment on cloud#553 (lists every merged PR + smoke test result).
2. If smoke test passed: run `workforce deploy ./examples/review-agent/persona.json --mode cloud` against a personal GitHub repo, force-open a PR, watch the agent post a review.
3. If smoke test failed: inspect logs, decide whether to revert or push fix.

### What this workflow does NOT deliver

- Memory wiring (loud hole).
- M3 destroy/list CLI commands.
- `@workforce/daytona-runner` npm publish (separate agent).
- cloud#554 Daytona meter flip-to-ready (platform-team gates).

---

## Merge DAG — auto-merge order

The workflow's lead Claude walks this DAG topologically. Each node auto-merges when (a) it's opened/exists, (b) all its dependencies are merged, (c) CI green, (d) no `CHANGES_REQUESTED` reviews, (e) no merge conflicts.

```
                         ┌───────────────────────────────┐
                         │ workforce#95 (already merged) │
                         └─────────────┬─────────────────┘
                                       │
            ┌──────────────────────────┴───────────────────────────┐
            │                                                       │
            ▼                                                       ▼
  ┌──────────────────────┐                            ┌──────────────────────────────┐
  │ Track A (cloud)      │                            │ Track D (workforce)          │
  │ #553 body + DB       │                            │ persona-kit refactor          │
  │ migrations           │                            │ traits-out + sandbox-out      │
  └──────────┬───────────┘                            └──────────┬───────────────────┘
             │                                                    │
   ┌─────────┼──────────┐                              ┌──────────┼─────────────┐
   ▼         ▼          ▼                              ▼          ▼             ▼
 Track B   Track G   Track F                        Track E1  Track E2 ... E5
 resolver  endpoint  runtime (deps on A + D)        rebase    rebase
  (cloud)  (cloud)   (workforce)                   #92        #93/#94/#96/#97
                       │                              │
                       ▼                              ▼
                    Track H (workforce)            (queue rebased)
                    --mode cloud                       │
                       │                              ▼
                       ▼                          Track I (workforce)
                    Track K (smoke test)          --input flags

  ┌────────────────────────────────────────────────────────────┐
  │ Chain branch (paired contracts — verify both merged):      │
  │   cloud#548 ─── relaycron#5 ─── relay#843 ─── relayauth#39 │
  │   ↓                                                         │
  │   Track L (cloud) — remove in-tree @agent-relay/* packages  │
  │   Track C (already done) — coordination comment             │
  └────────────────────────────────────────────────────────────┘

  Track J (cloud) ← depends on cloud#555 merged
```

**Concrete merge sequence the lead Claude executes:**

1. workforce#87 (auto-merge with input fix verified)
2. Track A opens + auto-merges (cloud schema)
3. cloud#551 auto-merges (already unblocked; orthogonal)
4. Track D opens + auto-merges (workforce persona-kit)
5. Track E1–E5 (rebase #92, #93, #94, #96, #97) — parallel; each auto-merges on green
6. cloud#548 + relaycron#5 + relay#843 + relayauth#39 — chain branch group merges (verify all on chain branch are green simultaneously, then merge in repo order: relayauth#39 → relay#843 → relaycron#5 → cloud#548)
7. Track G opens + auto-merges (cloud deploy endpoint; depends on Track A + cloud#548 + relaycron#5)
8. Track B opens + auto-merges (cloud resolver)
9. Track F opens + auto-merges (workforce runtime; depends on Track D + Track A)
10. Track H opens + auto-merges (workforce --mode cloud; depends on Track D + Track G)
11. Track I opens + auto-merges (workforce --input flags; depends on Track D + Track A)
12. Track L opens + auto-merges (cloud OSS-scope cleanup; depends on cloud#548 + relay#843 merged)
13. cloud#555 auto-merges if green + Track J's follow-ups open + auto-merge
14. workforce#89 (README, nice-to-have) auto-merges last
15. Track K runs (smoke test); reports result; does NOT block any merge.

**Failure handling per step:** if any node breaks the cascade (CI red after fixer loop, conflict-resolution fails), the workflow:
- Posts a loud failure to `#wf-schema-cascade`.
- Annotates the broken PR with a comment explaining the failure.
- Leaves all previously-merged work merged.
- Continues with INDEPENDENT downstream nodes (e.g. Track J doesn't depend on Track F; if F breaks, J can still proceed).
- Stops dependent nodes (e.g. if Track A breaks, Track G can't run).

## When Ricky is blocked

- **workforce#95 not merged at start?** Tracks D/E/F exit immediately with `WAITING: workforce#95`. A/B/C may proceed.
- **Track A back-fill migration breaks on existing prod-shaped data?** Open the migrations PR as DRAFT with the failing back-fill rows listed; don't try to skip them. Human resolves.
- **Track E sub-track has unmergeable conflicts?** Open `<original-branch>-rebased` as a separate PR, comment on original linking it, STOP that sub-track. Others continue.
- **A persona fixture had a `traits` block that consumers depend on?** Don't add traits back. Surface in PR body: `TODO(human): consumer X expected traits.<field>; recommend extracting to persona-personality-builder (out of scope for v1).`
- **`agent-assistant/proactive@0.4.32` introduces a breaking change in `fromContext`?** Pin to `0.4.31` in #96 with a `TODO(human): bump after consuming 0.4.32 breaking changes` note. Don't modify proactive bridge logic.

---

## Notes for the workflow author

- Use `proactive-runtime-m1.ts` as the structural reference for `dependsOn` edges, soft/hard gates, and review rounds.
- Tracks A/B/C run on cloud; D/E/F on workforce. Repo isolation prevents cross-track conflicts.
- Track E sub-tracks are independent of each other — generate parallel `dependsOn` edges (all five depend only on Track D).
- Lead Claude posts a per-track summary into `#wf-schema-cascade` at each gate transition.
- Final run report: post a summary comment on cloud#553 linking every PR + the migration plan.
