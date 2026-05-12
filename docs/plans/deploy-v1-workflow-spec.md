# Ricky workflow spec — `workforce deploy` v1 cross-repo work

**Status:** ready for Ricky to generate + run a workflow.
**Resolves:** the cross-repo + cloud-side pieces of `workforce deploy` v1.
**Companion docs:**
- `/Users/khaliqgant/Projects/AgentWorkforce/workforce/docs/plans/deploy-v1.md` (product plan — read this first for context)
- `/Users/khaliqgant/Projects/AgentWorkforce/workforce/docs/plans/deploy-v1-codex-spec.md` (parallel codex agent's tasks — do not duplicate)
**Reference workflow (shape to mirror):** `/Users/khaliqgant/Projects/AgentWorkforce/cloud-proactive-runtime-spec/workflows/proactive-runtime-m1.ts`

---

## How to consume this spec

This file is self-contained. Ricky should generate one workflow TS file (suggested name `workforce-deploy-v1.ts`) that orchestrates **all four ready-now tracks** below in parallel, with the proactive-runtime-m1 conventions (preflight → implementer → self-reflection → soft/hard gates → commit → push → draft PR per track, plus a cross-repo integration test track).

Two tracks are blocked and should be encoded as **separate** workflow files Ricky runs later (M3 and M6). Do not include them in the v1 workflow.

### Run command (final workflow)

```sh
npx tsx workflows/workforce-deploy-v1.ts
```

### Required env (repo paths)

Resolve these as env vars with the defaults shown. Ricky should set these to absolute paths inside its sandbox.

```
HOME=/Users/khaliqgant
ROOT=$HOME/Projects/AgentWorkforce

CLOUD_REPO=$ROOT/cloud
WORKFORCE_REPO=$ROOT/workforce
AGENT_ASSISTANT_REPO=$ROOT/agent-assistant
RELAYFILE_REPO=$ROOT/relayfile          # read-only reference
RELAY_REPO=$ROOT/relay                   # read-only reference
```

### Required secrets

```
DAYTONA_API_KEY                          # for cloud-side endpoint smoke test
GITHUB_TOKEN                             # for opening PRs
WORKFORCE_E2E_STAGING_TOKEN              # set in CI for the E2E job; not needed for the workflow itself
```

### Coordination shape

Hub-spoke / Conversation. A lead Claude Opus stays on `#wf-workforce-deploy-v1` as architect + ambient reviewer; codex implementers work tracks in parallel and iterate based on lead feedback. The workforce repo has a human engineer (separately) landing the runtime core, schema diff, deploy orchestrator entry, and CLI dispatch case — **do not touch those files; consume them as published interfaces.**

### Never-fail mechanics (mirror proactive-runtime-m1)

- Every test / typecheck / regression gate runs as soft → fixer → hard.
- Two review rounds: peer review → signoff → router → fix-r2 → final signoff. If round 2 still has gaps, every PR opens as **DRAFT** with the gap list templated into the body. Workflow exits 0.
- Global `onError`: retry, 2 retries, 10s backoff.
- Self-checks built in:
  - Per-track self-reflection vs the relevant track section below.
  - Per-track self-review via soft/hard gate loop.
  - Lead does ambient peer review during implementation.
  - Reviewer agent does formal peer review off the cross-repo diff.
  - Signoff agent verifies the v1 acceptance contract end-to-end.
  - Router routes back to fixer if signoff is INCOMPLETE.

### Branching, worktree, and PR conventions

**One branch per track.** Names listed inline per track below. Base on `origin/main` at workflow start.

**Worktrees are required when two or more tracks share a repo.** In this workflow:
- `$CLOUD_REPO` is used by Track A only → no worktree needed; operate in place on the branch.
- `$WORKFORCE_REPO` is shared by Tracks B, C, and INT → **each track operates in its own git worktree**. Path conventions:

  ```
  $WORKFORCE_REPO                                # Track B (consume Daytona)   → branch feat/deploy-v1-daytona-consume
  $WORKFORCE_REPO.wt-mcp                         # Track C (MCP server)        → branch feat/mcp-workforce
  $WORKFORCE_REPO.wt-e2e                         # Track INT (E2E test)        → branch feat/deploy-v1-e2e
  ```

  Create with:
  ```sh
  cd $WORKFORCE_REPO
  git fetch origin main
  git worktree add $WORKFORCE_REPO.wt-mcp -b feat/mcp-workforce origin/main
  git worktree add $WORKFORCE_REPO.wt-e2e -b feat/deploy-v1-e2e origin/main
  ```

  Each track's preflight command must `cd` into its worktree path and operate exclusively there. **Never `cd` into another track's worktree.** The workflow generator should encode the worktree path as a per-track constant, not as a mutable variable.

  **Cleanup:** Ricky **never** runs `git worktree remove`. Worktrees stay on disk until a human prunes them after PR merge. This keeps draft PRs reviewable against their own snapshot.

**Preflight allow-list pattern.** Each track defines its allowed-dirty regex (the set of files Ricky may find dirty from a previous run). Anything outside the allow-list fails preflight to prevent clobbering in-flight human work. Mirror `proactive-runtime-m1.ts:115-122`. Suggested allow-lists are documented per track.

**PR conventions (all tracks):**
- **Always open as DRAFT.** Even on green. Human flips to ready after review.
- **Base branch:** `main` in the target repo.
- **Title format:** `<type>(<scope>): <summary>` — e.g. `feat(daytona-runner): extract DaytonaRuntime into publishable package`. Use scope = package name when adding/changing a package.
- **Body template:**
  ```markdown
  ## Summary
  <one paragraph describing the change>

  ## Spec
  Resolves part of: `workforce/docs/plans/deploy-v1.md`
  Track: <A | B | C | INT> in `workforce/docs/plans/deploy-v1-workflow-spec.md`

  ## Sibling PRs
  - <link to dependent PRs in this workflow run>

  ## Acceptance
  - [ ] <each acceptance bullet from the track section, checked or unchecked>

  ## Gaps (if any)
  <list of acceptance bullets not yet met, with why — only present when PR opens as draft due to round-2 review gaps>

  🤖 Generated by Ricky workflow `workforce-deploy-v1`
  ```
- **No `--no-verify`.** Pre-commit hooks must pass. If they fail, fix the issue and create a new commit; do not amend or bypass.
- **Co-author trailer:** include `Co-Authored-By: <implementer model> via Ricky <noreply@agentworkforce.com>` on each commit Ricky generates.

**Cross-track dependencies:**
- Track B pins `@workforce/daytona-runner` to Track A's pre-release tag or branch. Ricky must wait for Track A to push at least one commit + tag before Track B's implementer starts. Encode as a `dependsOn` edge in the workflow DAG.
- Track INT waits for A, B, C all to be merged (or marked ready-for-review with green CI). Encode as a `dependsOn` edge.

### Acceptance contract (workflow-level)

After all four ready-now tracks complete, the following must be true:

1. `@workforce/daytona-runner` is published to npm and importable from `workforce`.
2. `POST /api/v1/workspaces/:id/sandboxes` returns a usable sandbox handle when called with a workspace token.
3. `@agentworkforce/mcp-workforce` is published and a smoke test proves the harness can call `memory.save` + `memory.recall` round-trip.
4. The cross-repo integration test (Track INT) passes: a `weekly-digest` example deploys via `--mode sandbox`, fires a cron tick, posts to a fixture GitHub repo within 60s.

---

## Tracks (ready now — include in `workforce-deploy-v1.ts`)

Each track has its own preflight, install, implementer (codex/claude with model below), self-reflection, soft/hard gates (test + typecheck), and ends with commit + push + draft PR.

### Track A — `@workforce/daytona-runner` package extraction + sandbox issuance endpoint

**Repo:** `$CLOUD_REPO` (no worktree — single track per repo, operate in place)
**Implementer model:** codex (high reasoning).
**Working branch:** `feat/workforce-daytona-runner`
**Allowed-dirty regex:** `package-lock\.json|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|packages/daytona-runner/.*|packages/core/src/runtime/.*|packages/core/src/auth/.*|packages/web/app/api/v1/workspaces/.*sandboxes.*`
**PR title:** `feat(daytona-runner): extract DaytonaRuntime into publishable package + workforce sandbox endpoint`
**Rationale:** workforce's `--mode sandbox` consumes Daytona. The wrapper at `cloud/packages/core/src/runtime/daytona.ts` is battle-tested; extracting it into a publishable package is cleaner than copying. The sandbox issuance endpoint (~30 lines) means workforce users don't need their own Daytona account.

**Preflight:**
- Verify `$CLOUD_REPO` is a valid clone, `main` is up to date.
- Verify `corepack pnpm install` runs clean.

**Implementation steps:**

1. Create `cloud/packages/daytona-runner/` as a publishable package named `@workforce/daytona-runner`.
   - `package.json`: ESM, type: module, `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`. Workspace version-aligned with rest of cloud.
   - Source layout:
     ```
     packages/daytona-runner/src/
       runtime.ts          # the DaytonaRuntime class, moved verbatim
       auth.ts             # resolveDaytonaAuthCredentials, moved verbatim
       types.ts            # ExecOptions, ExecResult, LaunchOptions, RuntimeCapabilities, RuntimeHandle, WorkflowRuntime
       index.ts            # barrel exporting public surface
       runtime.test.ts     # smoke test (skipped without DAYTONA_API_KEY)
     ```
   - Public exports from `index.ts`:
     ```ts
     export { DaytonaRuntime } from './runtime.js';
     export { resolveDaytonaAuthCredentials } from './auth.js';
     export type { RuntimeHandle, LaunchOptions, ExecOptions, ExecResult, RuntimeCapabilities, WorkflowRuntime } from './types.js';
     ```

2. Move (don't copy) `DaytonaRuntime` and its types out of `cloud/packages/core/src/runtime/daytona.ts` and `cloud/packages/core/src/auth/credentials.ts` into the new package.

3. Re-export from the old locations to keep cloud's existing imports working:
   ```ts
   // cloud/packages/core/src/runtime/daytona.ts (now a re-export shim)
   export { DaytonaRuntime, type RuntimeHandle, type LaunchOptions, type ExecOptions, type ExecResult } from '@workforce/daytona-runner';
   ```

4. Update `cloud/pnpm-workspace.yaml` to include the new package.

5. Add an integration test in `packages/daytona-runner/src/runtime.test.ts`:
   - Skips when `DAYTONA_API_KEY` is absent.
   - When present: creates a sandbox, runs `node -e 'console.log("ok")'`, asserts output, destroys.
   - Use the existing test runner / vitest config from cloud.

6. Add `POST /api/v1/workspaces/:id/sandboxes` to the cloud API. Auth: workspace token (same primitive as other workspace-scoped endpoints — find it in `cloud/packages/web/app/api/v1/workspaces/` and mirror the pattern).
   - Request body:
     ```ts
     { purpose: 'workforce-deploy'; personaId: string; label?: string; env?: Record<string,string>; timeoutSeconds?: number }
     ```
   - Handler:
     ```ts
     const auth = resolveDaytonaAuthCredentials({
       apiKey: process.env.DAYTONA_API_KEY,
       jwtToken: process.env.DAYTONA_JWT_TOKEN,
       organizationId: process.env.DAYTONA_ORGANIZATION_ID,
     });
     const daytona = new Daytona(auth);
     const sandbox = await daytona.create({ language: 'typescript', name: body.label, envVars: body.env });
     return { sandboxId: sandbox.id, jwtToken: <minted>, organizationId: auth.organizationId, expiresAt };
     ```
   - If the Daytona SDK cannot mint a per-sandbox JWT, ship instead as a proxy endpoint pair:
     - `POST /api/v1/workspaces/:id/sandboxes/:sandboxId/exec` body `{ command, cwd?, env?, timeoutSeconds? }`
     - `PUT /api/v1/workspaces/:id/sandboxes/:sandboxId/files` body `{ entries: Array<{ source: base64; destination: string }> }`
     - Workforce CLI uses these via a thin "remote Daytona" client. Note the trade in the PR body.
   - Audit-log every sandbox creation with `workspaceId`, `personaId`, `sandboxId`, `requester`. Use the existing audit-log primitive in cloud.
   - Add `DELETE /api/v1/workspaces/:id/sandboxes/:sandboxId` for explicit teardown.

7. Run the cloud test suite + typecheck. Soft → fixer → hard.

8. Open draft PR. Body links to this spec + the parallel workforce-side consumption PR (Track B).

**Acceptance:**
- New package compiles, lints, tests pass.
- `cloud`'s existing workflows still build (re-export shim is transparent).
- The sandbox endpoint returns a working handle in the integration test (when `DAYTONA_API_KEY` is set).
- PR is open as draft, body links spec.

**Effort estimate:** ~3.5h.

---

### Track B — workforce consumes `@workforce/daytona-runner` + sandbox endpoint

**Repo:** `$WORKFORCE_REPO` (operate in place — this track owns the primary checkout; C and INT use worktrees)
**Implementer model:** codex (medium reasoning).
**Working branch:** `feat/deploy-v1-daytona-consume`
**Allowed-dirty regex:** `package\.json|pnpm-lock\.yaml|packages/deploy/.*|packages/cli/src/cli\.ts|examples/.*/README\.md`
**PR title:** `feat(deploy): use @workforce/daytona-runner + workforce-managed sandbox issuance`
**Depends on:** Track A's PR is in flight (does not need to be merged — Ricky pins to the branch / pre-release).

**Preflight:**
- Verify `$WORKFORCE_REPO` is on a branch that contains the codex agent's `packages/deploy/src/modes/sandbox.ts` (from `deploy-v1-codex-spec.md` Task 4). If not present yet, **block this track** until that file lands; do not stub.

**Implementation steps:**

1. Add `@workforce/daytona-runner` to `packages/deploy/package.json` deps (pin to Track A's branch or pre-release tag).

2. Rewrite `packages/deploy/src/modes/sandbox.ts` to use `DaytonaRuntime`:
   ```ts
   import { DaytonaRuntime } from '@workforce/daytona-runner';
   import { Daytona } from '@daytonaio/sdk';
   import { resolveDaytonaAuth } from '../daytona-auth.js';

   export async function runSandbox(input: SandboxRunInput): Promise<SandboxRunHandle> {
     const auth = await resolveDaytonaAuth();
     const daytona = new Daytona(auth);
     const runtime = new DaytonaRuntime({ daytona });
     const handle = await runtime.launch({ env: input.env, label: input.bundle.personaCopyPath });
     // upload bundle files…
     // exec(`node runner.mjs`)…
     return { sandboxId: handle.id, stop: () => runtime.destroy(handle), done };
   }
   ```
   - Public function signature must match what the codex agent shipped (no changes to callers).
   - **Do not** call `runtime.destroy(handle)` automatically when `exec` returns — workforce agents are long-lived. Only destroy on explicit `stop()`.

3. Create `packages/deploy/src/daytona-auth.ts`:
   ```ts
   export interface DaytonaAuth { apiKey?: string; jwtToken?: string; organizationId?: string; }

   export async function resolveDaytonaAuth(): Promise<DaytonaAuth> {
     if (process.env.DAYTONA_API_KEY) return { apiKey: process.env.DAYTONA_API_KEY };
     // workforce-managed path
     const workforceCloudUrl = process.env.WORKFORCE_CLOUD_URL ?? 'https://cloud.agentworkforce.com';
     const workspaceToken = await loadWorkspaceToken(); // from keychain via existing workforce login flow
     const res = await fetch(`${workforceCloudUrl}/api/v1/workspaces/${workspace.id}/sandboxes`, {
       method: 'POST',
       headers: { authorization: `Bearer ${workspaceToken}`, 'content-type': 'application/json' },
       body: JSON.stringify({ purpose: 'workforce-deploy', personaId, label, env, timeoutSeconds }),
     });
     if (!res.ok) throw new Error(`sandbox issuance failed: ${res.status} ${await res.text()}`);
     const { jwtToken, organizationId } = await res.json();
     return { jwtToken, organizationId };
   }
   ```
   - `loadWorkspaceToken` lives in workforce's login module owned by the human engineer; if it isn't yet exported, leave `TODO(human): need loadWorkspaceToken export` and inline-stub with `process.env.WORKFORCE_WORKSPACE_TOKEN`.

4. Add a `--byo-sandbox` CLI flag (in `packages/cli/src/cli.ts`'s deploy case) that forces BYO even when logged in. Mirrors `--no-connect` style.

5. Update `examples/weekly-digest/README.md` and `examples/review-agent/README.md` to document both paths:
   - BYO: `export DAYTONA_API_KEY=...`
   - Workforce-managed: `workforce login` (no Daytona env needed)

6. Run `corepack pnpm run check`. Soft → fixer → hard.

7. Open draft PR. Body links to this spec + Track A's PR.

**Acceptance:**
- `workforce deploy ./examples/weekly-digest/persona.json --mode sandbox` works in both auth paths (verify with a manual run if creds are available; otherwise stop at typecheck-green).
- Tests pass.
- PR open as draft.

**Effort estimate:** ~1.5h.

---

### Track C — `@agentworkforce/mcp-workforce` MCP server

**Repo:** `$WORKFORCE_REPO.wt-mcp` (worktree — create with `git worktree add $WORKFORCE_REPO.wt-mcp -b feat/mcp-workforce origin/main` before this track starts)
**Implementer model:** codex (high reasoning).
**Working branch:** `feat/mcp-workforce`
**Allowed-dirty regex:** `package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|packages/mcp-workforce/.*`
**PR title:** `feat(mcp-workforce): MCP server bridging harnesses to workforce primitives`
**Rationale:** when a persona's `onEvent` calls `ctx.harness.run(...)`, the harness (Claude Code / Codex / opencode) spawns inside the sandbox and needs tool access to workforce primitives (workflow.run, memory.save/recall, integration RPCs). MCP is the canonical contract.

**Preflight:**
- Verify `$WORKFORCE_REPO` has `packages/runtime/src/clients/` populated. If not (codex Task 1 not merged yet), implement the **server skeleton + memory + workflow tools** now; **leave integration tools as TODO** with a placeholder that throws `not yet wired`. Open the PR anyway as draft.
- Verify `$AGENT_ASSISTANT_REPO` exposes `@agent-assistant/memory` (it does today — see `agent-assistant/packages/memory/src/memory.ts`).

**Implementation steps:**

1. Create `packages/mcp-workforce/` package.
   - `package.json`: depends on `@modelcontextprotocol/sdk`, `@agent-assistant/memory`, `@agentworkforce/runtime` (workspace), `@agentworkforce/persona-kit` (workspace).
   - Bin entry: `npx @agentworkforce/mcp-workforce` resolves to `dist/server.js`.

2. Source layout:
   ```
   packages/mcp-workforce/src/
     server.ts                    # MCP stdio server entry
     tools/
       workflow.ts                # workflow.run, workflow.status
       memory.ts                  # memory.save, memory.recall
       integrations.ts            # integration.<provider>.<method>
     config.ts                    # reads WORKFORCE_PERSONA_PATH, WORKFORCE_RUNTIME_TOKEN, WORKFORCE_WORKSPACE_ID
     index.ts
     *.test.ts                    # one per tool file
   ```

3. Server skeleton: use `@modelcontextprotocol/sdk` stdio transport. At startup, read env (`WORKFORCE_PERSONA_PATH`, `WORKFORCE_RUNTIME_TOKEN`, `WORKFORCE_WORKSPACE_ID`) and register the tool set below. The runtime sets these when spawning the harness via `ctx.harness.run`.

4. Tools:

   | Tool | Args (Zod) | Returns | Backed by |
   |---|---|---|---|
   | `workflow.run` | `{ name: string; args: Record<string, unknown> }` | `{ runId, status, output? }` | HTTP POST to `${WORKFORCE_CLOUD_URL}/api/v1/workflows/run` |
   | `workflow.status` | `{ runId: string }` | `{ status, output?, error? }` | HTTP GET |
   | `memory.save` | `{ content: string; tags?: string[]; scope?: 'session'\|'user'\|'workspace' }` | `{ ok: true }` | `@agent-assistant/memory` writeMemory |
   | `memory.recall` | `{ query: string; limit?: number }` | `{ items: MemoryItem[] }` | `@agent-assistant/memory` query |
   | `integration.<provider>.<method>` | varies | varies | delegates to `@agentworkforce/runtime/clients` (or throws "not yet wired" if codex Task 1 isn't merged) |

5. Tests:
   - Unit tests per tool, mocking the underlying memory adapter / integration clients.
   - One integration test: spin up the server, send `memory.save` then `memory.recall`, assert round-trip. Skip when `SUPERMEMORY_API_KEY` is absent.

6. Document the persona-side wiring in `packages/mcp-workforce/README.md`:
   ```jsonc
   // The workforce runtime injects this automatically when ctx.harness.run is called.
   // Personas do not need to declare it — but for power users, it's:
   "mcpServers": {
     "workforce": { "command": "npx", "args": ["@agentworkforce/mcp-workforce"] }
   }
   ```

7. Run `corepack pnpm run check`. Soft → fixer → hard.

8. Open draft PR.

**Acceptance:**
- Package compiles, tests pass.
- Memory round-trip integration test passes when `SUPERMEMORY_API_KEY` is set.
- Workflow tools wired (HTTP calls smoke-tested against staging).
- Integration tools wired if codex Task 1 merged; otherwise TODO with clear error message.
- PR open as draft.

**Effort estimate:** ~4h.

---

### Track INT — Cross-repo integration test

**Repo:** `$WORKFORCE_REPO.wt-e2e` (worktree — create with `git worktree add $WORKFORCE_REPO.wt-e2e -b feat/deploy-v1-e2e origin/main` before this track starts)
**Implementer model:** codex (medium reasoning).
**Working branch:** `feat/deploy-v1-e2e`
**Allowed-dirty regex:** `package\.json|pnpm-lock\.yaml|packages/deploy/test/.*|\.github/workflows/deploy-e2e\.yml|docs/plans/deploy-v1-e2e-fixtures\.md`
**PR title:** `test(deploy): cross-repo E2E for weekly-digest + review-agent`
**Depends on:** Tracks A, B, C, plus codex spec Tasks 1–5 merged.

**Preflight:**
- Verify all dependencies have landed. If not, **block** this track; do not run until ready.
- Confirm fixture credentials are present: `WORKFORCE_E2E_STAGING_TOKEN`, GitHub PAT for `AgentWorkforce/deploy-e2e-fixtures`, Linear API key for the staging project.

**Implementation steps:**

1. Add `packages/deploy/test/e2e/` directory. Use vitest with a 5-minute test timeout.

2. Test 1 — weekly-digest `--mode dev`:
   - `deploy(persona, { mode: 'dev', noConnect: false })` against staging workspace.
   - Simulate a `cron.tick` via the runtime's test hook (or wait up to 60s for the next tick if the schedule is dense in tests).
   - Assert a GitHub issue exists on `AgentWorkforce/deploy-e2e-fixtures` with the expected title pattern.
   - Cleanup: close the issue.

3. Test 2 — review-agent `--mode sandbox`:
   - `deploy(persona, { mode: 'sandbox' })` against staging workspace.
   - Open a PR via the GitHub API on the fixture repo.
   - Assert the agent posts a review within 90s.
   - Cleanup: close the PR + destroy the sandbox via `DELETE /api/v1/workspaces/:id/sandboxes/:id`.

4. Test 3 (only if codex spec Task 8 — `linear-shipper` example — is merged):
   - Create a Linear issue via the API.
   - Assert the agent clones + harness-runs + opens a PR + comments back on the Linear issue.

5. Each test cleans up after itself.

6. Add `.github/workflows/deploy-e2e.yml` running `pnpm run test:e2e` on a nightly schedule + manual dispatch. Failures notify `#workforce-alerts`.

7. Document fixture setup in `docs/plans/deploy-v1-e2e-fixtures.md`: which repo, which Linear project, which Slack workspace.

**Acceptance:**
- All applicable tests pass once.
- Nightly CI job is green.
- Fixture-setup doc committed.

**Effort estimate:** ~5h.

---

## Tracks (blocked — separate workflow files when unblocked)

Do **not** include these in `workforce-deploy-v1.ts`. Encode each as its own file under `workflows/` when the blocker clears.

### Track CLOUD — `--cloud` deploy mode wiring (blocked on cloud proactive-runtime M4)

**Why blocked:** cloud proactive-runtime M4 is the milestone that adds `POST /api/v1/workspaces/:id/deployments` (the "accept a persona bundle, host it" endpoint). Until M4 lands, workforce's `--mode cloud` flag prints "not yet available."

**Workflow filename when unblocked:** `workflows/workforce-deploy-cloud-mode.ts`.

**Repos touched when unblocked:**
- `$CLOUD_REPO` — implement the deployments endpoint per M4 spec; reuse Durable Object infra from M1's agent-gateway.
- `$WORKFORCE_REPO` — replace `packages/deploy/src/modes/cloud.ts` stub with real POST + status polling.

**Acceptance when unblocked:**
- `workforce deploy ./examples/weekly-digest/persona.json --mode cloud` produces a hosted agent that fires from cloud, not the user's machine.
- `workforce deployments list` and `workforce deployments destroy <id>` work.

### Track BILL — Billing meter for workforce-managed sandboxes (post-v1)

**Why deferred:** the sandbox endpoint ships in Track A with audit logging. Wiring the audit log into the workspace billing meter is mechanical but needs platform-team alignment on meter naming.

**Workflow filename when scheduled:** `workflows/workforce-deploy-billing.ts`.

**Repo touched:** `$CLOUD_REPO` only.

**Acceptance:**
- Sandbox minutes appear on the workspace billing dashboard.

### Track DOCS — Documentation site updates (after codex tasks 6/7/9 + human schema diff merge)

**Why deferred:** docs lift from the JSON Schema export (codex Task 7), trigger registry (codex Task 6), and README (codex Task 9). They must merge first.

**Workflow filename when scheduled:** `workflows/workforce-deploy-docs.ts`.

**Repo touched:** the AgentWorkforce docs site (resolve `$DOCS_REPO` when the workflow runs).

**Acceptance:**
- Concept doc, quickstart, persona schema reference, per-provider trigger reference, and runtime handler API page are live.

---

## Out of scope for Ricky

- Anything inside `$WORKFORCE_REPO/packages/persona-kit`, `packages/runtime` core, `packages/deploy/src/index.ts` entry, or `packages/cli/src/cli.ts` — the human engineer owns these. Consume as published interfaces.
- The codex agent's tasks (`docs/plans/deploy-v1-codex-spec.md`) — that agent runs separately.
- `deploy-v1.md`, this spec, and the codex spec — do not modify the plans.

## When Ricky is blocked

- **Daytona SDK can't mint per-sandbox JWTs?** Pivot Track A part B to the proxy-endpoint variant described in the spec. Note the trade in the PR body. Do not block.
- **A codex Track 1 interface doesn't match Track C's expectations?** Open a comment thread on the codex Task 1 PR. Stub against the documented contract in `deploy-v1-codex-spec.md`. Open Track C PR as draft with the diff in the body.
- **Cloud test suite flake?** Use the soft → fixer → hard gate loop; if it flakes twice, quarantine the test, file a follow-up issue, exit 0 with draft PR.
