import { workflow } from '@agent-relay/sdk/workflows';

// =============================================================================
// Ricky workflow: deploy-v1 schema cascade + persona refactor
// =============================================================================
// Source spec: workforce/docs/plans/deploy-v1-schema-cascade-spec.md
// Reference shape: cloud-proactive-runtime-spec/workflows/proactive-runtime-m1.ts
//
// SWARM PATTERN: hub-spoke (per spec line 64; per choosing-swarm-patterns SKILL).
//
//   Why hub-spoke and not pipeline/dag/fan-out:
//     - Lead Claude needs to STAY ALIVE on #wf-schema-cascade and adapt in real
//       time (ambient peer review, cross-repo contract reconciliation, status
//       probes every 5 min). That is the canonical hub-spoke use case
//       (choosing-swarm-patterns SKILL.md "Quick Decision Framework":
//       "Does a coordinator need to stay alive and adapt? YES -> hub-spoke").
//     - 14+ tracks across 5 repos (cloud, workforce, relay, relaycron,
//       relayauth) with cross-repo contracts (paired cloud#548 + relaycron#5
//       + relay#843 merges). Workers must coordinate via the channel; the
//       lead picks up contract drift and pings both owning implementers.
//     - pipeline is wrong: most tracks fan out in parallel from a shared
//       readiness gate (Tracks A and D run concurrently; E1-E5 run as five
//       parallel rebases after D).
//     - pure dag is wrong: there is no live coordinator. The spec REQUIRES a
//       live coordinator ("Lead Claude Opus stays on #wf-schema-cascade as
//       architect + ambient reviewer" - spec line 64).
//     - fan-out would lose the bidirectional lead<->worker conversation
//       needed for CHANGES_REQUESTED iteration.
//
// IMPLEMENTATION_WORKFLOW_CONTRACT: every track produces source changes,
// tests, non-empty diff evidence, and PR/result reporting. Auto-merge after
// CI green + no CHANGES_REQUESTED + no unresolved review comments.
//
// 80-to-100 contract: child track work performs fix-loop work; the lead and
// signoff perform final-review evidence checks before flipping draft -> ready
// and squash-merging. PRs only flip to ready and auto-merge when:
//   - CI is green on the PR
//   - typecheck + tests pass after soft -> fixer -> hard loop
//   - upstream dependencies in the Merge DAG are merged
//   - no human reviewer has CHANGES_REQUESTED
//   - no unresolved review comments
// Otherwise the PR stays as DRAFT with the loud-hole gap list templated into
// the body. Workflow exits 0 either way.
//
// Never-fail mechanics (mirror proactive-runtime-m1.ts):
//   - Every test / typecheck / regression gate runs as soft -> fixer -> hard.
//   - Per-track self-reflection vs the spec's per-track acceptance bullets.
//   - Two self-review passes per track: normal review + fresh-eyes review
//     (different reviewer, no prior context).
//   - Peer review by a DIFFERENT implementer; if CHANGES_REQUESTED, the
//     ORIGINAL implementer fixes (preserves track context).
//   - Final signoff agent verifies acceptance bullets; on INCOMPLETE, route
//     to fix-r2 then back through signoff-final.
//   - Lead Claude does ambient peer review on the channel during impl.
//   - Global onError: retry 2x, 10s backoff.
//
// Run:
//   npx tsx workflows/generated/ricky-ricky-workflow-spec-deploy-v1-schema-cascade-persona-refactor-status-ready-for-r.ts
// =============================================================================

const HOME = process.env.HOME ?? '/Users/khaliqgant';
const ROOT = `${HOME}/Projects/AgentWorkforce`;

const REPOS = {
  cloud:      process.env.CLOUD_REPO      ?? `${ROOT}/cloud`,
  workforce:  process.env.WORKFORCE_REPO  ?? `${ROOT}/workforce`,
  relay:      process.env.RELAY_REPO      ?? `${ROOT}/relay`,
  relaycron:  process.env.RELAYCRON_REPO  ?? `${ROOT}/relaycron`,
  relayauth:  process.env.RELAYAUTH_REPO  ?? `${ROOT}/relayauth`,
} as const;

const GH_REPOS = {
  cloud:     'AgentWorkforce/cloud',
  workforce: 'AgentWorkforce/workforce',
  relay:     'AgentWorkforce/relay',
  relaycron: 'AgentWorkforce/relaycron',
  relayauth: 'AgentWorkforce/relayauth',
} as const;

const CHANNEL = 'wf-schema-cascade';
const SPEC_FILE = `${REPOS.workforce}/docs/plans/deploy-v1-schema-cascade-spec.md`;
const ARTIFACTS = `${REPOS.workforce}/.workflow-artifacts/deploy-v1-schema-cascade`;

type TrackId =
  | 'A' | 'B' | 'C' | 'D'
  | 'E1' | 'E2' | 'E3' | 'E4' | 'E5'
  | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N';

interface TrackDef {
  id: TrackId;
  repo: keyof typeof REPOS;
  ghRepo: string;
  branch: string;
  // Worktree directory ('' means operate in place in REPOS[repo]).
  worktreeSuffix: string;
  prTitle: string;
  // Tracks whose PRs must be merged before this track auto-merges
  // (per spec "Merge DAG - auto-merge order").
  mergeAfter: TrackId[];
  // External PR numbers that must be merged first (paired-contract handling).
  externalMergeAfter: { repo: keyof typeof REPOS; pr: number; description: string }[];
  // Spec section heading for self-reflection prompts.
  specSection: string;
  // Brief per-track scope summary used in implementer prompts.
  scope: string;
  // Allow-list of files that may be dirty on entry (for preflight tolerance).
  allowedDirty: string;
  typecheckCmd: string;
  testCmd: string;
  reasoning: 'low' | 'medium' | 'high';
  autoMerge: boolean;
  commentOnly?: boolean;
}

const TRACKS: TrackDef[] = [
  {
    id: 'A',
    repo: 'cloud',
    ghRepo: GH_REPOS.cloud,
    branch: 'chore/db1-schema-lockin',
    worktreeSuffix: '',
    prTitle: 'feat(db): DB1 schema lock-ins per cloud#553 thread',
    mergeAfter: [],
    externalMergeAfter: [],
    specSection: 'Track A — Cloud #553 schema lock-ins (issue body + migrations PR)',
    scope: [
      'Update cloud#553 issue body to reflect every lock-in (two-table agent model, integration_scopes, persona_versions, cli_auth_sessions split, sharing rule prose, sub-agents note, sandbox-minute metering, lock-in revision history).',
      'Open migrations PR on branch chore/db1-schema-lockin. New tables: agents, persona_versions, integration_scopes, user_integrations, workspace_integrations, workforce_cli_auth_sessions. Rename cli_auth_sessions -> cloud_cli_bootstrap_sessions. Repurpose agent_deployments for per-instance rows with back-fill migration.',
      'Add agents.watch_globs text[] NULL and agents.schedule_ids text[] NULL columns for Track G consumption.',
      'Add adapter text NOT NULL DEFAULT \'nango\' columns to user_integrations and workspace_integrations.',
      'Run drizzle codegen so packages/web/lib/db/schema.ts matches.',
    ].join(' '),
    allowedDirty: 'package(-lock)?\\.json|packages/web/drizzle/.*|packages/web/lib/db/.*|packages/web/lib/proactive-runtime/.*|docs/.*',
    typecheckCmd: 'npm run typecheck',
    testCmd: 'npm test',
    reasoning: 'high',
    autoMerge: true,
  },
  {
    id: 'B',
    repo: 'cloud',
    ghRepo: GH_REPOS.cloud,
    branch: 'feat/integration-resolver-source-dispatch',
    worktreeSuffix: '.wt-resolver',
    prTitle: 'feat(integrations): resolver dispatches on source + adapter',
    mergeAfter: ['A'],
    externalMergeAfter: [],
    specSection: 'Track B — Cloud resolver: dispatch on `source` + `adapter`',
    scope: [
      'Update cloud integration resolver in packages/web/lib/integrations/ and packages/web/lib/proactive-runtime/deploy-manager.ts.',
      'Read source from persona spec: deployer_user / workspace / workspace_service_account. Default missing source to { kind: deployer_user }.',
      'GitHub combine: provider=github AND source.kind=deployer_user loads workspace_integrations row. Fail clearly if workspace install missing.',
      'Adapter dispatch: nango (existing) / composio (existing) / pipedream (throw not-yet-wired).',
      'Add resolver test fixtures covering all source kinds, GitHub combine paths, default injection, adapter dispatch.',
    ].join(' '),
    allowedDirty: 'packages/web/lib/integrations/.*|packages/web/lib/proactive-runtime/deploy-manager\\.ts|packages/web/app/api/v1/integrations/.*',
    typecheckCmd: 'npm run typecheck',
    testCmd: 'npm test',
    reasoning: 'medium',
    autoMerge: true,
  },
  {
    id: 'C',
    repo: 'cloud',
    ghRepo: GH_REPOS.cloud,
    branch: '',
    worktreeSuffix: '',
    prTitle: '(no PR — comment-only)',
    mergeAfter: [],
    externalMergeAfter: [],
    specSection: 'Track C — Cloud #548 OSS-scope rebase coordination',
    scope: 'Verify the coordination comment already exists on cloud#548 referencing @agent-relay/{events,agent}@6.0.18 (the version that landed when relay#843 publish completed 2026-05-12T21:49:38Z). If missing, re-post the comment body.',
    allowedDirty: '',
    typecheckCmd: 'true',
    testCmd: 'true',
    reasoning: 'medium',
    autoMerge: false,
    commentOnly: true,
  },
  {
    id: 'D',
    repo: 'workforce',
    ghRepo: GH_REPOS.workforce,
    branch: 'refactor/persona-kit-schema-lockin',
    worktreeSuffix: '',
    prTitle: 'refactor(persona-kit): remove traits + sandbox, add listeners JSDoc (deploy-v1)',
    mergeAfter: [],
    externalMergeAfter: [],
    specSection: 'Track D — Workforce persona-kit refactor (traits-out, sandbox-out, listeners doc)',
    scope: [
      'Remove Traits type and spec.traits parsing from packages/persona-kit. Update fixtures + examples. Parser REJECTS personas containing a traits key with the specified error.',
      'Remove SandboxConfig type and spec.sandbox parsing. Verify @agentworkforce/deploy reads sandbox config from deploy options, NOT persona.spec. Parser REJECTS personas containing a sandbox key.',
      'Add listeners JSDoc on PersonaIntegrationConfig, Schedule, and top-level PersonaSpec (clock/radio/inbox narrative).',
      'Keep PersonaSpec.memory.scopes accepting workspace | user | global (drop session if present).',
      'Regenerate persona JSON schema via packages/persona-kit/scripts/emit-schema.mjs if present.',
      'Add parse-failure tests with specific error messages.',
      'Verify 14 core personas validate via corepack pnpm -r --filter @agentworkforce/personas-core run lint.',
    ].join(' '),
    allowedDirty: 'packages/persona-kit/.*|packages/runtime/src/proactive\\.ts|packages/runtime/src/types\\.ts|packages/runtime/src/ctx\\.ts|packages/deploy/src/.*|examples/.*|docs/plans/.*',
    typecheckCmd: 'corepack pnpm run typecheck',
    testCmd: 'corepack pnpm -r run test',
    reasoning: 'high',
    autoMerge: true,
  },
  {
    id: 'E1',
    repo: 'workforce',
    ghRepo: GH_REPOS.workforce,
    branch: 'feat/integrations-vfs',
    worktreeSuffix: '.wt-rebase-92',
    prTitle: '(rebase PR #92 onto post-Track-D main)',
    mergeAfter: ['D'],
    externalMergeAfter: [],
    specSection: 'Track E1 — rebase #92 (feat/integrations-vfs)',
    scope: 'Rebase #92 onto post-Track-D main. VFS substrate doesn\'t touch traits/sandbox; conflicts should be minimal. Push with --force-with-lease.',
    allowedDirty: 'packages/.*|.*\\.json',
    typecheckCmd: 'corepack pnpm run typecheck',
    testCmd: 'corepack pnpm -r run test',
    reasoning: 'medium',
    autoMerge: true,
  },
  {
    id: 'E2',
    repo: 'workforce',
    ghRepo: GH_REPOS.workforce,
    branch: 'feat/integrations-vfs-examples',
    worktreeSuffix: '.wt-rebase-93',
    prTitle: '(rebase PR #93 — strip traits/sandbox from examples)',
    mergeAfter: ['D', 'E1'],
    externalMergeAfter: [],
    specSection: 'Track E2 — rebase #93 (feat/integrations-vfs-examples)',
    scope: 'Rebase #93 onto post-Track-D main + strip traits and sandbox blocks from examples/review-agent/persona.json and examples/linear-shipper/persona.json. Verify both type-check against #92 WorkforceCtx.',
    allowedDirty: 'examples/.*|packages/.*|.*\\.json',
    typecheckCmd: 'corepack pnpm run typecheck',
    testCmd: 'corepack pnpm -r run test',
    reasoning: 'medium',
    autoMerge: true,
  },
  {
    id: 'E3',
    repo: 'workforce',
    ghRepo: GH_REPOS.workforce,
    branch: 'feat/persona-json-schema',
    worktreeSuffix: '.wt-rebase-94',
    prTitle: '(rebase PR #94 — regen persona schema)',
    mergeAfter: ['D'],
    externalMergeAfter: [],
    specSection: 'Track E3 — rebase #94 (feat/persona-json-schema)',
    scope: 'Rebase #94 + run scripts/emit-schema.mjs to regenerate packages/persona-kit/schemas/persona.schema.json. Verify fixtures still validate.',
    allowedDirty: 'packages/persona-kit/.*|.*\\.json',
    typecheckCmd: 'corepack pnpm run typecheck',
    testCmd: 'corepack pnpm -r run test',
    reasoning: 'medium',
    autoMerge: true,
  },
  {
    id: 'E4',
    repo: 'workforce',
    ghRepo: GH_REPOS.workforce,
    branch: 'feat/proactive-bridge',
    worktreeSuffix: '.wt-rebase-96',
    prTitle: '(rebase PR #96 — bump @agent-assistant/proactive ^0.4.32)',
    mergeAfter: ['D'],
    externalMergeAfter: [],
    specSection: 'Track E4 — rebase #96 (feat/proactive-bridge)',
    scope: 'Rebase #96. Drop any remaining expressionFromTraits references. Bump @agent-assistant/proactive ^0.4.31 -> ^0.4.32. Run corepack pnpm install to refresh pnpm-lock.yaml. Verify baseline tests pass.',
    allowedDirty: 'packages/.*|.*\\.json|pnpm-lock\\.yaml',
    typecheckCmd: 'corepack pnpm run typecheck',
    testCmd: 'corepack pnpm -r run test',
    reasoning: 'medium',
    autoMerge: true,
  },
  {
    id: 'E5',
    repo: 'workforce',
    ghRepo: GH_REPOS.workforce,
    branch: 'feat/persona-integration-source',
    worktreeSuffix: '.wt-rebase-97',
    prTitle: '(rebase PR #97 — feat/persona-integration-source)',
    mergeAfter: ['D'],
    externalMergeAfter: [],
    specSection: 'Track E5 — rebase #97 (feat/persona-integration-source)',
    scope: 'Rebase #97. Interface name is PersonaIntegrationConfig (verified). No content change beyond rebase.',
    allowedDirty: 'packages/.*|.*\\.json',
    typecheckCmd: 'corepack pnpm run typecheck',
    testCmd: 'corepack pnpm -r run test',
    reasoning: 'medium',
    autoMerge: true,
  },
  {
    id: 'F',
    repo: 'workforce',
    ghRepo: GH_REPOS.workforce,
    branch: 'feat/runtime-input-values-resolution',
    worktreeSuffix: '.wt-runtime',
    prTitle: 'feat(runtime): resolve persona inputs from agents.input_values + expose ctx.agent/ctx.deployment',
    mergeAfter: ['A', 'D'],
    externalMergeAfter: [],
    specSection: 'Track F — Workforce runtime input-values + agent identity wiring',
    scope: [
      'In packages/runtime/src/ctx.ts: read input_values from the agents row (not agent_deployments). resolved[key] = agents.input_values[key] ?? persona.spec.inputs[key].default. Throw on required-without-value.',
      'Update WorkforceCtx.persona.inputs shape: Record<string, string> resolved values. Add ctx.persona.inputSpecs for consumers needing the spec.',
      'Add ctx.agent (id, deployedName, spawnedByAgentId) and ctx.deployment (id, triggerKind, parentDeploymentId) accessors.',
      'Tests: override wins; default fills; required-missing throws specified error; ctx.persona.inputSpecs exposes defaults; ctx.agent.id + ctx.deployment.id populated.',
    ].join(' '),
    allowedDirty: 'packages/runtime/src/ctx\\.ts|packages/runtime/src/types\\.ts|packages/runtime/src/ctx\\.test\\.ts|packages/runtime/src/__tests__/.*',
    typecheckCmd: 'corepack pnpm run typecheck',
    testCmd: 'corepack pnpm -r run test',
    reasoning: 'medium',
    autoMerge: true,
  },
  {
    id: 'G',
    repo: 'cloud',
    ghRepo: GH_REPOS.cloud,
    branch: 'feat/persona-bundle-deploy-endpoint',
    worktreeSuffix: '.wt-deploy-endpoint',
    prTitle: 'feat(deploy): persona+bundle deploy endpoint',
    mergeAfter: ['A'],
    externalMergeAfter: [
      { repo: 'cloud', pr: 548, description: 'cloud#548 (agent-gateway DO + relaycron-client + registerWatches)' },
      { repo: 'relaycron', pr: 5, description: 'relaycron#5 (WS delivery + cancel API)' },
    ],
    specSection: 'Track G — Cloud persona+bundle deploy endpoint',
    scope: [
      'POST /api/v1/workspaces/:workspaceId/deployments taking persona+bundle.',
      'Validate persona via parsePersonaSpec. Insert persona_versions row if spec_hash new. Upsert agents row matched on (workspace_id, persona_id).',
      'Translate persona.integrations.<p>.triggers[] -> watch glob list (e.g. provider=github trigger.on=pull_request.opened -> /github/pull_requests/opened/**). Persist on agents.watch_globs.',
      'Translate persona.schedules[] -> relaycron registrations via services/agent-gateway/src/relaycron-client.ts:registerCronSchedules. Persist on agents.schedule_ids.',
      'Provision Daytona sandbox + upload bundle via existing POST /api/v1/workspaces/:id/sandboxes infrastructure. Start runner.mjs.',
      'Insert initial agent_deployments row status=running trigger_kind=inbox. Audit-log.',
      'Tests: happy path, re-deploy same persona, invalid persona, trigger translation, schedule registration, sandbox + bundle order, auth.',
    ].join(' '),
    allowedDirty: 'packages/web/app/api/v1/workspaces/.*|packages/web/lib/proactive-runtime/.*|packages/web/lib/.*persona.*|services/agent-gateway/.*',
    typecheckCmd: 'npm run typecheck',
    testCmd: 'npm test',
    reasoning: 'high',
    autoMerge: true,
  },
  {
    id: 'H',
    repo: 'workforce',
    ghRepo: GH_REPOS.workforce,
    branch: 'feat/deploy-mode-cloud',
    worktreeSuffix: '.wt-mode-cloud',
    prTitle: 'feat(deploy): --mode cloud (OSS-generic persona+bundle POST)',
    mergeAfter: ['D', 'G'],
    externalMergeAfter: [],
    specSection: 'Track H — Workforce `--mode cloud` (OSS-generic implementation)',
    scope: [
      'Replace stubbed packages/deploy/src/modes/cloud.ts with real implementation that POSTs persona+bundle to a configurable cloud-deploy URL.',
      'URL precedence: --cloud-url flag > WORKFORCE_CLOUD_URL env > persona.cloud.deployUrl > default https://agentrelay.com.',
      'OSS-generic: do not bake agentrelay.com into code paths (only as a default URL).',
      'Auth via packages/deploy/src/login.ts. 401 -> clean error suggesting workforce login. Retry with backoff (3 attempts).',
      'Status polling resolves on active and failed. stop() calls DELETE endpoint.',
    ].join(' '),
    allowedDirty: 'packages/deploy/src/modes/cloud\\.ts|packages/deploy/src/index\\.ts|packages/deploy/src/login\\.ts|packages/cli/src/cli\\.ts',
    typecheckCmd: 'corepack pnpm run typecheck',
    testCmd: 'corepack pnpm -r run test',
    reasoning: 'medium',
    autoMerge: true,
  },
  {
    id: 'I',
    repo: 'workforce',
    ghRepo: GH_REPOS.workforce,
    branch: 'feat/deploy-input-flags',
    worktreeSuffix: '.wt-deploy-inputs',
    prTitle: 'feat(deploy): --input <key>=<value> flags across all modes',
    mergeAfter: ['A', 'D', 'F'],
    externalMergeAfter: [],
    specSection: 'Track I — Deploy CLI `--input <key>=<value>` flags',
    scope: [
      'Accept --input <key>=<value> flag in packages/cli/src/cli.ts (repeatable). Parse into Record<string, string>. Reject malformed flags.',
      'Plumb through packages/deploy/src/index.ts deploy() function as DeployOptions.inputs.',
      'Validate against persona spec at deploy time. Unknown key -> "Unknown input \'<key>\'; persona declares: <list>".',
      'Forward to each mode: dev (env vars WORKFORCE_INPUT_<KEY>), sandbox (Daytona envVars), cloud (POST body inputs field).',
      'Update persona spec docs in docs/plans/deploy-v1.md §3.',
    ].join(' '),
    allowedDirty: 'packages/cli/src/cli\\.ts|packages/deploy/src/index\\.ts|packages/deploy/src/types\\.ts|packages/deploy/src/modes/.*',
    typecheckCmd: 'corepack pnpm run typecheck',
    testCmd: 'corepack pnpm -r run test',
    reasoning: 'medium',
    autoMerge: true,
  },
  {
    id: 'J',
    repo: 'cloud',
    ghRepo: GH_REPOS.cloud,
    branch: 'feat/workflow-invocations-followups',
    worktreeSuffix: '.wt-workflow-shim-followups',
    prTitle: 'feat(workflows): synthesis policy + scope mint follow-ups for cloud#555',
    mergeAfter: [],
    externalMergeAfter: [
      { repo: 'cloud', pr: 555, description: 'cloud#555 (workflow-invocations shim) must be merged' },
    ],
    specSection: 'Track J — `workflow.run` MCP synthesis + scope mint (cloud#555 follow-ups)',
    scope: [
      'J1: slug -> workflow translation in packages/web/lib/workflows/invocation-registry.ts. Synthesis: s3CodeKey=workflows/<slug>/latest.tar.gz, sourceFileType=workflow, runtime={id:daytona} from workspace default_runtime, args forwarded as metadata.invocationArgs. Initial registry: { echo }.',
      'J2: scope mint additions. packages/web/app/api/v1/workflows/run/route.ts mints workflow:invoke:write + workflow:invoke:read. Add requireAuthScope checks to new /workspaces/:id/workflows/run + /workspaces/:id/workflows/runs/:runId routes.',
      'Tests: J1 echo round-trip; unknown slug 404; J2 missing scope 403; with scope success.',
    ].join(' '),
    allowedDirty: 'packages/web/app/api/v1/workspaces/.*workflows/.*|packages/web/lib/workflows/.*|packages/web/lib/auth/.*sandbox.*',
    typecheckCmd: 'npm run typecheck',
    testCmd: 'npm test',
    reasoning: 'high',
    autoMerge: true,
  },
  {
    id: 'L',
    repo: 'cloud',
    ghRepo: GH_REPOS.cloud,
    branch: 'chore/remove-agent-relay-packages',
    worktreeSuffix: '.wt-oss-cleanup',
    prTitle: 'chore: remove in-tree @agent-relay/{events,agent}; consume from npm',
    mergeAfter: [],
    externalMergeAfter: [
      { repo: 'cloud', pr: 548, description: 'cloud#548 must be merged first' },
      { repo: 'relay', pr: 843, description: 'relay#843 merged 2026-05-12T21:30:54Z; publish workflow completed 21:49:38Z. @agent-relay/* lockstep-bumped to 6.0.18. Safety check: poll `npm view @agent-relay/sdk version` and ensure >= 6.0.18 before pinning.' },
    ],
    specSection: 'Track L — Cloud OSS-scope cleanup (post-#548 merge)',
    scope: [
      'Delete cloud/packages/agent-relay-events/ and cloud/packages/agent-relay-agent/. Add npm deps @agent-relay/{events,agent}: ^<published-version> to services/agent-gateway/package.json and other consumers.',
      'Refresh package-lock.json via npm install.',
      'Bump other @agent-relay/* pins to keep the umbrella aligned.',
      'grep .github/workflows/*.yml + Makefile for refs to agent-relay-events / agent-relay-agent needing cleanup.',
    ].join(' '),
    allowedDirty: 'package(-lock)?\\.json|packages/.*|services/.*|\\.github/workflows/.*|Makefile',
    typecheckCmd: 'npm run typecheck',
    testCmd: 'npm test',
    reasoning: 'medium',
    autoMerge: true,
  },
  {
    id: 'M',
    repo: 'cloud',
    ghRepo: GH_REPOS.cloud,
    branch: 'chore/bump-relaycron-packages',
    worktreeSuffix: '.wt-relaycron-bump',
    prTitle: 'chore(deps): bump @relaycron/{server,types} to ^0.1.3',
    mergeAfter: [],
    externalMergeAfter: [
      { repo: 'relaycron', pr: 5, description: 'relaycron#5 merged + @relaycron/{server,types}@0.1.3 published' },
    ],
    specSection: 'Track M — Cloud `@relaycron/*` pin bump',
    scope: [
      'Bump @relaycron/server and @relaycron/types pins from ^0.1.0 -> ^0.1.3 in packages/relaycron/package.json (and packages/relaycron-types/package.json + root package.json if pinned).',
      'Run npm install to refresh package-lock.json. Run npm run typecheck. Run npm run relaycron:test.',
      'grep .github/workflows/*.yml for @relaycron/server or @relaycron/types refs needing bumps.',
    ].join(' '),
    allowedDirty: 'package(-lock)?\\.json|packages/relaycron/.*|packages/relaycron-types/.*|\\.github/workflows/.*',
    typecheckCmd: 'npm run typecheck',
    testCmd: 'npm run relaycron:test',
    reasoning: 'low',
    autoMerge: true,
  },
  {
    id: 'N',
    repo: 'cloud',
    ghRepo: GH_REPOS.cloud,
    branch: 'feat/sandbox-token-path-scoped',
    worktreeSuffix: '.wt-token-paths',
    prTitle: 'feat(sandbox): token path-scoping via POST /v1/tokens/path',
    mergeAfter: ['G'],
    externalMergeAfter: [
      { repo: 'relayauth', pr: 39, description: 'relayauth#39 (docs contract) must be merged' },
    ],
    specSection: 'Track N — Cloud sandbox token path-scoping',
    scope: [
      'Update Track G sandbox-provisioning flow to mint path-scoped tokens via POST /v1/tokens/path (per relayauth#39 contract).',
      'Tests: token mint path-scoping happy path; downstream sandbox bound to scoped path; legacy path still works during rollout.',
    ].join(' '),
    allowedDirty: 'packages/web/.*|services/agent-gateway/.*',
    typecheckCmd: 'npm run typecheck',
    testCmd: 'npm test',
    reasoning: 'medium',
    autoMerge: true,
  },
  {
    id: 'K',
    repo: 'workforce',
    ghRepo: GH_REPOS.workforce,
    branch: 'test/deploy-v1-e2e-smoke',
    worktreeSuffix: '.wt-smoke',
    prTitle: 'test(deploy): e2e smoke for weekly-digest --mode cloud',
    // Track K depends on every preceding track but does NOT block the cascade.
    mergeAfter: ['A', 'B', 'D', 'F', 'G', 'H', 'I', 'J', 'E1', 'E2', 'E3', 'E4', 'E5'],
    externalMergeAfter: [],
    specSection: 'Track K — End-to-end smoke test',
    scope: [
      'Add packages/deploy/test/e2e/weekly-digest.smoke.test.ts: build bundle, authenticate via WORKFORCE_E2E_STAGING_TOKEN (skip gracefully if missing), deploy via --mode cloud against WORKFORCE_E2E_STAGING_URL, force a cron tick, assert agent posts GitHub issue on AgentWorkforce/deploy-e2e-fixtures within 90s.',
      'Add .github/workflows/deploy-e2e.yml: nightly schedule + manual dispatch. Failures notify #workforce-alerts.',
      'Reports SMOKE_TEST: PASS or SMOKE_TEST: FAIL — does NOT block cascade.',
    ].join(' '),
    allowedDirty: 'packages/deploy/test/e2e/.*|\\.github/workflows/deploy-e2e\\.yml',
    typecheckCmd: 'corepack pnpm run typecheck',
    testCmd: 'corepack pnpm -r run test',
    reasoning: 'medium',
    autoMerge: false, // smoke test reports but does not block
  },
];

// ---------------------------------------------------------------------------
// Helper builders
// ---------------------------------------------------------------------------

function trackById(id: TrackId): TrackDef {
  const t = TRACKS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown track ${id}`);
  return t;
}

function workdir(t: TrackDef): string {
  if (!t.worktreeSuffix) return REPOS[t.repo];
  return `${REPOS[t.repo]}${t.worktreeSuffix}`;
}

function implAgentName(t: TrackDef): string {
  return `impl-${t.id.toLowerCase()}`;
}
function reflectAgentName(t: TrackDef): string {
  return `reflect-${t.id.toLowerCase()}`;
}
function freshEyesAgentName(t: TrackDef): string {
  return `fresh-eyes-${t.id.toLowerCase()}`;
}

// Peer review comes from a DIFFERENT implementer (cross-pollination catches
// blind spots). Rotate through the TRACKS array; skip comment-only tracks.
function peerReviewerName(t: TrackDef): string {
  const idx = TRACKS.findIndex((x) => x.id === t.id);
  for (let i = 1; i < TRACKS.length; i++) {
    const peer = TRACKS[(idx + i) % TRACKS.length];
    if (peer.commentOnly) continue;
    if (peer.id === t.id) continue;
    return implAgentName(peer);
  }
  return 'fixer';
}

// Loud-hole disclosure required in every PR body (per spec "Loud hole" §).
const LOUD_HOLE_LINES = [
  '## Known gaps after this PR',
  '',
  ':warning: **Memory is not wired.** `ctx.memory` is a stub in v1; see `docs/plans/deploy-v1-schema-cascade-spec.md` § Loud hole. Memory wiring lands in a follow-up workflow (not yet specced).',
  '',
  ':warning: **M3 destroy/list CLI commands** not implemented. Separate workflow.',
  '',
  ':warning: **`@workforce/daytona-runner` not on npm** under `@workforce` scope. Handled by a separate agent per platform-team OIDC setup; not blocking morning state because cloud consumes via workspace ref.',
];

// Preflight: branch checkout, allow-listed dirty tolerance, gh auth check.
function preflightCmd(t: TrackDef): string {
  const dir = workdir(t);
  const lines: string[] = [
    'set -e',
    `mkdir -p ${ARTIFACTS}/track-${t.id.toLowerCase()}`,
  ];
  if (t.commentOnly) {
    lines.push(
      'gh auth status >/dev/null 2>&1 || (echo "ERROR: gh CLI not authenticated"; exit 1)',
      `echo PREFLIGHT_OK_${t.id}`,
    );
    return lines.join('\n');
  }
  if (t.worktreeSuffix) {
    lines.push(
      `if [ ! -e "${dir}/.git" ]; then`,
      `  cd "${REPOS[t.repo]}" && git worktree add "${dir}" -b ${t.branch} origin/main 2>/dev/null || git worktree add "${dir}" ${t.branch}`,
      `fi`,
    );
  }
  lines.push(
    `cd "${dir}" || exit 1`,
    'git fetch origin main >/dev/null 2>&1 || true',
    'git config user.email "ricky@agent-relay.com"',
    'git config user.name "Ricky Schema Cascade"',
    `if git rev-parse --verify ${t.branch} >/dev/null 2>&1; then git checkout ${t.branch}; else git checkout -B ${t.branch} origin/main; fi`,
    'mkdir -p .git/info && grep -qxF ".logs/" .git/info/exclude 2>/dev/null || echo ".logs/" >> .git/info/exclude',
    `ALLOWED_DIRTY="${t.allowedDirty || 'package(-lock)?\\.json'}"`,
    'DIRTY_TRACKED=$(git diff --name-only | grep -vE "^(${ALLOWED_DIRTY})$" || true)',
    'DIRTY_UNTRACKED=$(git ls-files --others --exclude-standard | grep -vE "^(${ALLOWED_DIRTY})$" || true)',
    'if [ -n "$DIRTY_TRACKED" ] || [ -n "$DIRTY_UNTRACKED" ]; then',
    `  echo "ERROR: unexpected drift in track ${t.id} (${t.repo}):"`,
    '  [ -n "$DIRTY_TRACKED" ] && echo "tracked: $DIRTY_TRACKED"',
    '  [ -n "$DIRTY_UNTRACKED" ] && echo "untracked: $DIRTY_UNTRACKED"',
    '  exit 1',
    'fi',
    'if ! git diff --cached --quiet; then echo "ERROR: staging area dirty"; git diff --cached --stat; exit 1; fi',
    'gh auth status >/dev/null 2>&1 || (echo "ERROR: gh CLI not authenticated"; exit 1)',
    `echo PREFLIGHT_OK_${t.id}`,
  );
  return lines.join('\n');
}

// Soft gate — never throws; captures exit code into output.
function softCmd(t: TrackDef, label: string, cmd: string): string {
  const dir = workdir(t);
  return [
    'set -e',
    `cd "${dir}" || exit 1`,
    'mkdir -p .logs',
    'set +e',
    `${cmd} > .logs/${label}.log 2>&1; E=$?`,
    `echo "${label.toUpperCase()}_EXIT=$E"`,
    `tail -80 .logs/${label}.log`,
    'exit 0',
  ].join('\n');
}

// Merge-ready check: posts WAITING_FOR_<dep> and exits 0 (soft) when any
// dep is unmerged so the cascade can continue with independent tracks.
function mergeReadyCmd(t: TrackDef): string {
  const lines: string[] = ['set -e', 'READY=1', 'REASONS=""'];
  for (const dep of t.mergeAfter) {
    const depTrack = trackById(dep);
    if (depTrack.commentOnly) continue;
    lines.push(
      `STATE_${dep}=$(cat ${ARTIFACTS}/track-${dep.toLowerCase()}/merge-state.txt 2>/dev/null || echo "UNKNOWN")`,
      `if [ "$STATE_${dep}" != "MERGED" ]; then READY=0; REASONS="$REASONS Track-${dep}=$STATE_${dep}"; fi`,
    );
  }
  for (const ext of t.externalMergeAfter) {
    const key = `EXT_${ext.repo.toUpperCase()}_${ext.pr}`;
    lines.push(
      `${key}=$(gh pr view ${ext.pr} --repo ${GH_REPOS[ext.repo]} --json mergedAt -q '.mergedAt' 2>/dev/null || echo null)`,
      `if [ -z "$${key}" ] || [ "$${key}" = "null" ]; then READY=0; REASONS="$REASONS ${ext.repo}#${ext.pr}=unmerged"; fi`,
    );
  }
  lines.push(
    `echo "MERGE_READY_TRACK_${t.id}=$READY"`,
    'echo "REASONS:$REASONS"',
    `mkdir -p ${ARTIFACTS}/track-${t.id.toLowerCase()}`,
    `echo "$READY" > ${ARTIFACTS}/track-${t.id.toLowerCase()}/merge-ready.txt`,
    'exit 0',
  );
  return lines.join('\n');
}

// Auto-merge gate enforces spec's "Gates that BLOCK auto-merge" rules.
function autoMergeCmd(t: TrackDef): string {
  if (!t.autoMerge || t.commentOnly) {
    return [
      'set -e',
      `mkdir -p ${ARTIFACTS}/track-${t.id.toLowerCase()}`,
      `echo "Track ${t.id}: auto-merge not authorized — leaving PR as DRAFT."`,
      `echo NOT_AUTO_MERGED > ${ARTIFACTS}/track-${t.id.toLowerCase()}/merge-state.txt`,
    ].join('\n');
  }
  return [
    'set -e',
    `mkdir -p ${ARTIFACTS}/track-${t.id.toLowerCase()}`,
    `READY=$(cat ${ARTIFACTS}/track-${t.id.toLowerCase()}/merge-ready.txt 2>/dev/null || echo 0)`,
    `PR_NUM=$(cat ${ARTIFACTS}/track-${t.id.toLowerCase()}/pr-number.txt 2>/dev/null || echo "")`,
    `if [ "$READY" != "1" ] || [ -z "$PR_NUM" ]; then`,
    `  echo "Track ${t.id}: not merge-ready or PR not opened. Skipping auto-merge."`,
    `  echo SKIPPED > ${ARTIFACTS}/track-${t.id.toLowerCase()}/merge-state.txt`,
    `  exit 0`,
    `fi`,
    // Verify no CHANGES_REQUESTED from non-bot reviewers.
    `CR=$(gh pr view "$PR_NUM" --repo ${t.ghRepo} --json reviews -q '[.reviews[] | select(.state == "CHANGES_REQUESTED" and (.author.login | endswith("[bot]") | not))] | length' 2>/dev/null || echo 0)`,
    `if [ "$CR" != "0" ] && [ -n "$CR" ]; then`,
    `  echo "Track ${t.id}: CHANGES_REQUESTED present ($CR). Blocking auto-merge."`,
    `  echo BLOCKED_CHANGES_REQUESTED > ${ARTIFACTS}/track-${t.id.toLowerCase()}/merge-state.txt`,
    `  exit 0`,
    `fi`,
    // Unresolved human review comments (per spec line 113).
    // Conservative: any human review comment blocks unless RICKY_TRUST_UNRESOLVED_COMMENTS=1.
    `HUMAN_COMMENTS=$(gh api repos/${t.ghRepo}/pulls/$PR_NUM/comments --paginate -q '[.[] | select(.user.type == "User")] | length' 2>/dev/null || echo 0)`,
    `if [ "$HUMAN_COMMENTS" -gt 0 ] 2>/dev/null && [ "$RICKY_TRUST_UNRESOLVED_COMMENTS" != "1" ]; then`,
    `  echo "Track ${t.id}: $HUMAN_COMMENTS human review comments — blocking auto-merge (set RICKY_TRUST_UNRESOLVED_COMMENTS=1 to override)."`,
    `  echo BLOCKED_UNRESOLVED_COMMENTS > ${ARTIFACTS}/track-${t.id.toLowerCase()}/merge-state.txt`,
    `  exit 0`,
    `fi`,
    // Flip draft -> ready then squash --auto.
    `gh pr ready "$PR_NUM" --repo ${t.ghRepo} || echo "(already ready)"`,
    `gh pr merge "$PR_NUM" --repo ${t.ghRepo} --squash --auto || (echo MERGE_FAILED > ${ARTIFACTS}/track-${t.id.toLowerCase()}/merge-state.txt; exit 0)`,
    // Poll for the actual merge (auto-merge may queue). Cap at 15 min.
    `for i in $(seq 1 30); do`,
    `  M=$(gh pr view "$PR_NUM" --repo ${t.ghRepo} --json mergedAt -q '.mergedAt' 2>/dev/null || echo "")`,
    `  if [ -n "$M" ] && [ "$M" != "null" ]; then`,
    `    echo "Track ${t.id} merged at $M"`,
    `    echo MERGED > ${ARTIFACTS}/track-${t.id.toLowerCase()}/merge-state.txt`,
    `    exit 0`,
    `  fi`,
    `  sleep 30`,
    `done`,
    `echo "Track ${t.id}: auto-merge queued but not completed within 15 min."`,
    `echo AUTO_MERGE_QUEUED > ${ARTIFACTS}/track-${t.id.toLowerCase()}/merge-state.txt`,
    'exit 0',
  ].join('\n');
}

async function main() {
  const wf = workflow('ricky-ricky-workflow-spec-deploy-v1-schema-cascade-persona-refactor-status-ready-for-r')
    .description(
      'Deploy v1 schema cascade + persona refactor. Hub-spoke conversation: Lead Claude Opus stays on #wf-schema-cascade as architect + ambient reviewer; codex implementers run 14+ tracks across cloud/workforce/relay/relaycron/relayauth with per-track self-reflection, peer review (different implementer), fresh-eyes review (separate Claude), signoff, fix-r2, and auto-merge per the spec Merge DAG. Soft -> fixer -> hard gates throughout. Auto-merge when CI green + no CHANGES_REQUESTED + no unresolved comments.'
    )
    .pattern('hub-spoke')
    .channel(CHANNEL)
    .maxConcurrency(6)
    .timeout(28_800_000) // 8h ceiling: 18 tracks × ~14 phases × CI/merge polling, plus external PR waits. Original 4h was tight; reviewer recommended bumping.

    // -- Lead + reviewers + signoff + fixer (Claude Opus, interactive) -------
    .agent('lead', {
      cli: 'claude',
      role: `Architect on #${CHANNEL}. Owns the Merge DAG. Posts the plan; pings implementers; reads diffs in real time; reconciles cross-repo contracts (cloud<->workforce<->relay<->relaycron<->relayauth); approves tracks for round 1. Exits when ALL_TRACKS_APPROVED is posted.`,
      retries: 1,
    })
    .agent('reviewer-peer', {
      cli: 'claude',
      role: 'Formal cross-track peer reviewer. Reads diffs; compares vs per-track acceptance bullets; emits PEER_REVIEW: APPROVED or PEER_REVIEW: CHANGES_REQUESTED with per-track notes (file:line).',
      retries: 1,
    })
    .agent('signoff', {
      cli: 'claude',
      role: 'Final signoff agent. Re-reads spec acceptance bullets and verifies every track\'s bullets against actual files. Emits SIGNOFF: COMPLETE or SIGNOFF: INCOMPLETE: <gap-list per track>.',
      retries: 1,
    })
    .agent('fixer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Applies targeted fixes from any feedback (reflection, peer review, fresh-eyes review, signoff). Reads feedback + diffs, edits files in the right repo+worktree, exits.',
      retries: 2,
    });

  // Per-track codex implementers (interactive on channel so they hear lead feedback).
  for (const t of TRACKS) {
    if (t.commentOnly) {
      wf.agent(implAgentName(t), {
        cli: 'claude',
        role: `Track ${t.id} (${t.specSection}). Comment-only verification.`,
        retries: 1,
      });
    } else {
      wf.agent(implAgentName(t), {
        cli: 'codex',
        role: `Track ${t.id} (${t.repo}, branch ${t.branch}): ${t.specSection}. Listens on #${CHANNEL} for lead feedback. Iterates on CHANGES_REQUESTED.`,
        retries: 2,
      });
    }
  }

  // Per-track self-reflection analysts (separate Claude, reads only its own diff).
  for (const t of TRACKS) {
    wf.agent(reflectAgentName(t), {
      cli: 'claude',
      preset: 'analyst',
      role: `Self-reflection for Track ${t.id}. Reads diff vs the per-track acceptance bullets. Emits REFLECT_GAPS: <list> or REFLECT_GAPS: NONE.`,
      retries: 1,
    });
  }

  // Per-track fresh-eyes reviewers (separate Claude, NO prior workflow context).
  for (const t of TRACKS) {
    wf.agent(freshEyesAgentName(t), {
      cli: 'claude',
      preset: 'reviewer',
      role: `Fresh-eyes review for Track ${t.id}. NO prior workflow context. Reads only the spec section + the diff. Catches blind spots the implementer cannot see. Emits FRESH_EYES_REVIEW: APPROVED or FRESH_EYES_REVIEW: CHANGES_REQUESTED.`,
      retries: 1,
    });
  }

  // ============================================================
  // Phase 0 — Read spec ONCE into context (deterministic).
  // ============================================================
  wf.step('read-spec', {
    type: 'deterministic',
    command: `set -e\nmkdir -p ${ARTIFACTS}\ncat ${SPEC_FILE}`,
    captureOutput: true,
    failOnError: true,
  });

  // ============================================================
  // Phase 1 — Per-track preflight (parallel where possible).
  // ============================================================
  for (const t of TRACKS) {
    wf.step(`preflight-${t.id.toLowerCase()}`, {
      type: 'deterministic',
      dependsOn: ['read-spec'],
      command: preflightCmd(t),
      captureOutput: true,
      failOnError: false,
    });
  }

  wf.step('preflight-summary', {
    type: 'deterministic',
    dependsOn: TRACKS.map((t) => `preflight-${t.id.toLowerCase()}`),
    command: [
      'set -e',
      `mkdir -p ${ARTIFACTS}`,
      'echo "=== PREFLIGHT SUMMARY ==="',
      ...TRACKS.map((t) =>
        `echo "Track ${t.id}: $(echo \"{{steps.preflight-${t.id.toLowerCase()}.output}}\" | grep -oE 'PREFLIGHT_OK_[A-Z0-9]+|ERROR.*' | head -1)"`,
      ),
    ].join('\n'),
    captureOutput: true,
    failOnError: false,
  });

  // ============================================================
  // Phase 2 — Lead coordinate (the hub). Stays on the channel until
  // all tracks pass round-1 review, ambient-reviewing diffs as they land.
  // ============================================================
  const READY_DEPS = ['read-spec', 'preflight-summary'];

  wf.step('lead-coordinate', {
    agent: 'lead',
    dependsOn: READY_DEPS,
    task: [
      `You are the lead architect on #${CHANNEL}. Deploy-v1 schema cascade + persona refactor.`,
      `Spec file: ${SPEC_FILE}`,
      '',
      'SPEC (full):',
      '{{steps.read-spec.output}}',
      '',
      `Tracks (${TRACKS.length} total) and their implementers:`,
      ...TRACKS.map((t) => `  - @${implAgentName(t)} -- Track ${t.id} in ${t.repo} (${t.specSection})`),
      '',
      'Step 1 -- Post the cross-repo plan to the channel. Restate the Merge DAG (spec "Merge DAG -- auto-merge order"):',
      '  - Tracks A, D run first (parallel; no upstream deps).',
      '  - Track B depends on A; Track F depends on A + D; Track G depends on A + cloud#548 + relaycron#5; Track H depends on D + G.',
      '  - E1-E5 fan out after D.',
      '  - Track L depends on cloud#548 + relay#843 publish settled. Track M depends on relaycron#5. Track N depends on relayauth#39 + G.',
      '  - Track K runs after everything, reports SMOKE_TEST: PASS/FAIL -- does NOT block cascade.',
      '',
      'Step 2 -- Require ACK <name> from every implementer before they write code. Re-post + ping if a worker is silent for 3 minutes.',
      '',
      'Step 3 -- Every 5 minutes post a status probe naming all implementers. Each replies RUNNING / BLOCKED / DONE.',
      '',
      'Step 4 -- As workers post DONE, READ THEIR ACTUAL FILES and post per-track verdict:',
      '  "APPROVED Track-<id>" -- track is good for round 1',
      '  "CHANGES_REQUESTED Track-<id>: <specific notes with file:line>" -- worker iterates',
      '',
      'Step 5 -- Cross-repo contract reconciliation. Watch for mismatches between:',
      '  - Track A schema columns (agents.watch_globs, agents.schedule_ids) vs Track G consumption',
      '  - Track G endpoint contract vs Track H --mode cloud client',
      '  - Track A input_values column vs Track F runtime ctx vs Track I --input flags',
      '  - Track D persona-kit shape vs E1-E5 rebases',
      '  - Track M @relaycron pin vs Track L OSS-scope cleanup post relay#843 publish settling',
      'On mismatch, post @-pings to BOTH owning implementers and reconcile before approving either.',
      '',
      'Step 6 -- Exit when all tracks are APPROVED or have CHANGES_REQUESTED in a stable state. Post FINAL: ALL_TRACKS_APPROVED before exiting.',
      '',
      'Loud-hole reminders (spec "Loud hole"): every PR body MUST mention memory is not wired in v1. Do NOT let implementers forget this.',
      '',
      'Constraints:',
      '  - Do NOT write code. You review and coordinate.',
      '  - Do NOT commit anything. The workflow handles git.',
      '  - Do NOT use exit instructions; the runner self-terminates.',
    ].join('\n'),
    verification: { type: 'output_contains', value: 'ALL_TRACKS_APPROVED' },
  });

  // ============================================================
  // Phase 3 — Per-track implementer steps. All share READY_DEPS so they
  // start concurrently with the lead (no deadlock, per
  // writing-agent-relay-workflows SKILL "DAG Deadlock Anti-Pattern").
  // ============================================================
  for (const t of TRACKS) {
    wf.step(`impl-${t.id.toLowerCase()}-work`, {
      agent: implAgentName(t),
      dependsOn: READY_DEPS,
      task: [
        `You are ${implAgentName(t)} on #${CHANNEL}. TRACK ${t.id}.`,
        `Repo: ${REPOS[t.repo]}, branch ${t.branch}, workdir ${workdir(t)}.`,
        '',
        `Wait for the lead's plan on #${CHANNEL}, then ACK with "ACK ${implAgentName(t)}".`,
        '',
        'Spec (read fully):',
        '{{steps.read-spec.output}}',
        '',
        `Your section in the spec: "${t.specSection}".`,
        '',
        'Scope:',
        t.scope,
        '',
        t.commentOnly
          ? [
              'This track is comment-only. Verify the coordination comment exists on the target PR; re-post if missing.',
              'Do NOT branch, commit, or push.',
            ].join('\n')
          : [
              'Implementation rules:',
              `  - Stay in ${workdir(t)} on branch ${t.branch}.`,
              `  - Allowed-dirty regex: ${t.allowedDirty || '(default: package locks only)'}.`,
              '  - No --no-verify. Pre-commit hooks must pass.',
              '  - Include the loud-hole note (memory not wired) in any PR body you draft.',
              `  - Run typecheck (\`${t.typecheckCmd}\`) and tests (\`${t.testCmd}\`) until they pass.`,
              `  - Watch #${CHANNEL}. Iterate on CHANGES_REQUESTED Track-${t.id}: from the lead.`,
              `  - Post completion as: "DONE Track-${t.id}: <files-touched-summary>".`,
              '',
              'Constraints:',
              `  - Edit ONLY files matching the allow-list: ${t.allowedDirty || '(see spec section)'}.`,
              '  - Do NOT touch other tracks files.',
              '  - Do NOT commit; the workflow handles git.',
              `  - Do NOT exit until DONE Track-${t.id} is posted.`,
            ].join('\n'),
        '',
        'Quality bar: typecheck + tests pass; every acceptance bullet in the spec section is addressed.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    });
  }

  // ============================================================
  // Phase 4 — Per-track soft typecheck (never throws).
  // ============================================================
  for (const t of TRACKS) {
    if (t.commentOnly) continue;
    wf.step(`tsc-soft-${t.id.toLowerCase()}`, {
      type: 'deterministic',
      dependsOn: [`impl-${t.id.toLowerCase()}-work`],
      command: softCmd(t, `tsc-soft-${t.id.toLowerCase()}`, t.typecheckCmd),
      captureOutput: true,
      failOnError: false,
    });
  }

  // ============================================================
  // Phase 5 — Per-track typecheck fixer.
  // ============================================================
  for (const t of TRACKS) {
    if (t.commentOnly) continue;
    wf.step(`tsc-fix-${t.id.toLowerCase()}`, {
      agent: 'fixer',
      dependsOn: [`tsc-soft-${t.id.toLowerCase()}`],
      task: [
        `Typecheck output for Track ${t.id} (${workdir(t)}):`,
        `{{steps.tsc-soft-${t.id.toLowerCase()}.output}}`,
        '',
        `If TSC_SOFT_${t.id.toUpperCase()}_EXIT=0, exit immediately.`,
        `Otherwise fix type errors in ${workdir(t)}. Re-run \`${t.typecheckCmd}\` until it passes.`,
        'Do NOT silence with `as any` or `// @ts-ignore`. Fix the root cause.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    });
  }

  // ============================================================
  // Phase 6 — Per-track soft tests.
  // ============================================================
  for (const t of TRACKS) {
    if (t.commentOnly) continue;
    wf.step(`tests-soft-${t.id.toLowerCase()}`, {
      type: 'deterministic',
      dependsOn: [`tsc-fix-${t.id.toLowerCase()}`],
      command: softCmd(t, `tests-soft-${t.id.toLowerCase()}`, t.testCmd),
      captureOutput: true,
      failOnError: false,
    });
  }

  // ============================================================
  // Phase 7 — Per-track tests fixer.
  // ============================================================
  for (const t of TRACKS) {
    if (t.commentOnly) continue;
    wf.step(`tests-fix-${t.id.toLowerCase()}`, {
      agent: 'fixer',
      dependsOn: [`tests-soft-${t.id.toLowerCase()}`],
      task: [
        `Test output for Track ${t.id} (${workdir(t)}):`,
        `{{steps.tests-soft-${t.id.toLowerCase()}.output}}`,
        '',
        `If TESTS_SOFT_${t.id.toUpperCase()}_EXIT=0, exit immediately.`,
        `Otherwise read failures and fix EITHER the test or the source -- whichever is correct. Do NOT skip or delete tests.`,
        `Re-run \`${t.testCmd}\` until it passes.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });
  }

  // ============================================================
  // Phase 8 — Per-track HARD typecheck + tests (captured, never throws,
  // gates feed into signoff + PR body).
  // ============================================================
  for (const t of TRACKS) {
    if (t.commentOnly) continue;
    wf.step(`tsc-hard-${t.id.toLowerCase()}`, {
      type: 'deterministic',
      dependsOn: [`tests-fix-${t.id.toLowerCase()}`],
      command: softCmd(t, `tsc-hard-${t.id.toLowerCase()}`, t.typecheckCmd),
      captureOutput: true,
      failOnError: false,
    });
    wf.step(`tests-hard-${t.id.toLowerCase()}`, {
      type: 'deterministic',
      dependsOn: [`tests-fix-${t.id.toLowerCase()}`],
      command: softCmd(t, `tests-hard-${t.id.toLowerCase()}`, t.testCmd),
      captureOutput: true,
      failOnError: false,
    });
  }

  // ============================================================
  // Phase 9 — Self-reflection per track (Claude analyst).
  // Reads diff vs spec acceptance bullets; emits REFLECT_GAPS.
  // ============================================================
  for (const t of TRACKS) {
    wf.step(`reflect-${t.id.toLowerCase()}`, {
      agent: reflectAgentName(t),
      dependsOn: t.commentOnly
        ? [`impl-${t.id.toLowerCase()}-work`]
        : [`tsc-hard-${t.id.toLowerCase()}`, `tests-hard-${t.id.toLowerCase()}`],
      task: [
        `Self-reflection for Track ${t.id}.`,
        `Spec section: "${t.specSection}".`,
        `Read the diff in ${workdir(t)} (branch ${t.branch}) via:`,
        `  cd ${workdir(t)} && git diff origin/main`,
        '',
        'Spec (full):',
        '{{steps.read-spec.output}}',
        '',
        'Re-read your spec section acceptance bullets. For EACH bullet:',
        '  - Addressed in the diff? Where (file:line)?',
        '  - MISSING or PARTIAL?',
        '',
        'Output exactly this format:',
        '  REFLECT_GAPS:',
        '  - <gap 1 -- acceptance bullet quoted -- file:line if known>',
        '  - <gap 2 -- ...>',
        '',
        'If NO gaps, output: REFLECT_GAPS: NONE',
        '',
        'Be brutal. Read the actual files; do not trust chat.',
      ].join('\n'),
      verification: { type: 'output_contains', value: 'REFLECT_GAPS' },
    });
  }

  // ============================================================
  // Phase 10 — Self-reflection fix-loop: the ORIGINAL implementer
  // addresses its own track gaps (preserves track context).
  // ============================================================
  for (const t of TRACKS) {
    if (t.commentOnly) continue;
    wf.step(`reflect-fix-${t.id.toLowerCase()}`, {
      agent: implAgentName(t),
      dependsOn: [`reflect-${t.id.toLowerCase()}`],
      task: [
        `Self-reflection report for Track ${t.id}:`,
        `{{steps.reflect-${t.id.toLowerCase()}.output}}`,
        '',
        'If REFLECT_GAPS: NONE, exit immediately.',
        `Otherwise address every listed gap. Edit files in ${workdir(t)} only. Stay on branch ${t.branch}.`,
        '',
        `After fixes, re-run \`${t.typecheckCmd}\` and \`${t.testCmd}\`. They must pass.`,
        'Do not introduce new gaps. Do not edit files outside your allow-list.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    });
  }

  // ============================================================
  // Phase 11 — FRESH-EYES review per track. Separate Claude with NO
  // prior workflow context -- reads only spec section + diff.
  // ============================================================
  for (const t of TRACKS) {
    wf.step(`fresh-eyes-${t.id.toLowerCase()}`, {
      agent: freshEyesAgentName(t),
      dependsOn: t.commentOnly
        ? [`reflect-${t.id.toLowerCase()}`]
        : [`reflect-fix-${t.id.toLowerCase()}`],
      task: [
        `FRESH-EYES REVIEW for Track ${t.id}. You have NO prior workflow context.`,
        '',
        'Read ONLY two things:',
        `  1. The spec section: "${t.specSection}" in ${SPEC_FILE}`,
        `  2. The diff in ${workdir(t)} via: cd ${workdir(t)} && git diff origin/main`,
        '',
        'Do NOT read chat history or other tracks. You are the fresh-eyes safety net.',
        '',
        'Reviewer checklist:',
        '  - Do changes match the spec section acceptance bullets exactly?',
        '  - Are there spec items the implementer might have skipped because they "seemed obvious"?',
        '  - Are there cross-references in the spec the diff missed?',
        '  - Tests cover acceptance bullets, not just happy path?',
        '  - Is the loud-hole note present where required (memory not wired)?',
        '',
        'Emit exactly one of:',
        '  FRESH_EYES_REVIEW: APPROVED',
        'or',
        '  FRESH_EYES_REVIEW: CHANGES_REQUESTED',
        '  - <note 1 -- file:line>',
        '  - <note 2 -- ...>',
        '',
        'Be ruthless.',
      ].join('\n'),
      verification: { type: 'output_contains', value: 'FRESH_EYES_REVIEW' },
    });
  }

  // ============================================================
  // Phase 12 — Apply fresh-eyes fixes (ORIGINAL implementer).
  // ============================================================
  for (const t of TRACKS) {
    if (t.commentOnly) continue;
    wf.step(`fresh-eyes-fix-${t.id.toLowerCase()}`, {
      agent: implAgentName(t),
      dependsOn: [`fresh-eyes-${t.id.toLowerCase()}`],
      task: [
        `Fresh-eyes review for Track ${t.id}:`,
        `{{steps.fresh-eyes-${t.id.toLowerCase()}.output}}`,
        '',
        'If FRESH_EYES_REVIEW: APPROVED, exit immediately.',
        `Otherwise address every CHANGES_REQUESTED note in ${workdir(t)} only.`,
        '',
        `After fixes: cd ${workdir(t)} && ${t.typecheckCmd} && ${t.testCmd}.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });
  }

  // ============================================================
  // Phase 13 — PEER REVIEW per track from a DIFFERENT implementer.
  // If CHANGES_REQUESTED, the ORIGINAL implementer fixes (Phase 14).
  // ============================================================
  for (const t of TRACKS) {
    const peer = peerReviewerName(t);
    wf.step(`peer-review-${t.id.toLowerCase()}`, {
      agent: peer,
      dependsOn: t.commentOnly
        ? [`fresh-eyes-${t.id.toLowerCase()}`]
        : [`fresh-eyes-fix-${t.id.toLowerCase()}`],
      task: [
        `PEER REVIEW for Track ${t.id}. You are ${peer}, normally the implementer for a different track.`,
        '',
        `Read the diff in ${workdir(t)}: cd ${workdir(t)} && git diff origin/main`,
        '',
        `Spec section: "${t.specSection}".`,
        '',
        'Spec (full):',
        '{{steps.read-spec.output}}',
        '',
        'Review for:',
        '  - Correctness vs acceptance bullets',
        '  - Tests covering happy path AND edge cases in the spec section',
        '  - No regressions in adjacent code',
        '  - Cross-repo contracts honored (if your own track contract intersects)',
        '  - Loud-hole note is in the PR body draft (if applicable)',
        '',
        'Emit exactly one of:',
        '  PEER_REVIEW: APPROVED',
        'or',
        '  PEER_REVIEW: CHANGES_REQUESTED',
        '  - <note 1 -- file:line>',
        '  - <note 2 -- ...>',
      ].join('\n'),
      verification: { type: 'output_contains', value: 'PEER_REVIEW' },
    });
  }

  // ============================================================
  // Phase 14 — Apply peer-review fixes (ORIGINAL implementer).
  // ============================================================
  for (const t of TRACKS) {
    if (t.commentOnly) continue;
    wf.step(`peer-review-fix-${t.id.toLowerCase()}`, {
      agent: implAgentName(t),
      dependsOn: [`peer-review-${t.id.toLowerCase()}`],
      task: [
        `Peer review for Track ${t.id}:`,
        `{{steps.peer-review-${t.id.toLowerCase()}.output}}`,
        '',
        'If PEER_REVIEW: APPROVED, exit immediately.',
        `Otherwise address every CHANGES_REQUESTED note in ${workdir(t)} only.`,
        '',
        `After fixes: cd ${workdir(t)} && ${t.typecheckCmd} && ${t.testCmd}.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });
  }

  // ============================================================
  // Phase 15 — Per-track final hard gate after all review loops.
  // ============================================================
  for (const t of TRACKS) {
    if (t.commentOnly) continue;
    wf.step(`final-gate-${t.id.toLowerCase()}`, {
      type: 'deterministic',
      dependsOn: [`peer-review-fix-${t.id.toLowerCase()}`],
      command: [
        'set +e',
        `cd ${workdir(t)}`,
        'mkdir -p .logs',
        `${t.typecheckCmd} > .logs/final-tsc.log 2>&1; T=$?`,
        `${t.testCmd} > .logs/final-tests.log 2>&1; X=$?`,
        `echo "FINAL_${t.id}_TSC=$T"`,
        `echo "FINAL_${t.id}_TESTS=$X"`,
        'tail -40 .logs/final-tsc.log',
        'tail -40 .logs/final-tests.log',
        'exit 0',
      ].join('\n'),
      captureOutput: true,
      failOnError: false,
    });
  }

  // ============================================================
  // Phase 16 — Per-track SIGNOFF agent verifies acceptance bullets.
  // ============================================================
  for (const t of TRACKS) {
    wf.step(`signoff-${t.id.toLowerCase()}`, {
      agent: 'signoff',
      dependsOn: t.commentOnly
        ? [`peer-review-${t.id.toLowerCase()}`]
        : [`final-gate-${t.id.toLowerCase()}`],
      task: [
        `Final signoff for Track ${t.id}.`,
        '',
        'Re-read the spec acceptance bullets for this track:',
        '{{steps.read-spec.output}}',
        '',
        `Track section: "${t.specSection}".`,
        '',
        t.commentOnly
          ? 'Verify the comment-only action was completed (gh pr view confirms the comment exists).'
          : `Read the diff in ${workdir(t)}: cd ${workdir(t)} && git diff origin/main`,
        '',
        t.commentOnly
          ? ''
          : `Final gate status:\n{{steps.final-gate-${t.id.toLowerCase()}.output}}`,
        '',
        'For EACH acceptance bullet, mark [x] satisfied or [ ] gap.',
        '',
        'Emit exactly one of:',
        `  SIGNOFF: COMPLETE Track-${t.id}`,
        'or',
        `  SIGNOFF: INCOMPLETE Track-${t.id}`,
        '  - <gap 1 -- acceptance bullet>',
        '  - <gap 2 -- ...>',
        '',
        'Read files. Do not trust chat. Even if INCOMPLETE, exit cleanly -- the workflow ships DRAFT with the gap list.',
      ].join('\n'),
      verification: { type: 'output_contains', value: 'SIGNOFF:' },
    });
  }

  // ============================================================
  // Phase 17 — Per-track router (deterministic): COMPLETE or NEEDS_FIX.
  // ============================================================
  for (const t of TRACKS) {
    wf.step(`router-${t.id.toLowerCase()}`, {
      type: 'deterministic',
      dependsOn: [`signoff-${t.id.toLowerCase()}`],
      command: [
        'set -e',
        `mkdir -p ${ARTIFACTS}/track-${t.id.toLowerCase()}`,
        `BODY=${ARTIFACTS}/track-${t.id.toLowerCase()}/signoff.txt`,
        `cat <<'SIGNOFF_EOF' > $BODY`,
        `{{steps.signoff-${t.id.toLowerCase()}.output}}`,
        'SIGNOFF_EOF',
        `if grep -q "^SIGNOFF: COMPLETE Track-${t.id}" $BODY; then`,
        `  echo "ROUTE_${t.id}: COMPLETE"`,
        `  echo complete > ${ARTIFACTS}/track-${t.id.toLowerCase()}/router.txt`,
        'else',
        `  echo "ROUTE_${t.id}: NEEDS_FIX"`,
        `  echo needs-fix > ${ARTIFACTS}/track-${t.id.toLowerCase()}/router.txt`,
        'fi',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    });
  }

  // ============================================================
  // Phase 18 — Round-2 fix agent (no-op if router said COMPLETE).
  // ============================================================
  for (const t of TRACKS) {
    if (t.commentOnly) continue;
    wf.step(`fix-r2-${t.id.toLowerCase()}`, {
      agent: 'fixer',
      dependsOn: [`router-${t.id.toLowerCase()}`],
      task: [
        `Router decision for Track ${t.id}:`,
        `{{steps.router-${t.id.toLowerCase()}.output}}`,
        '',
        `Signoff verdict for Track ${t.id}:`,
        `{{steps.signoff-${t.id.toLowerCase()}.output}}`,
        '',
        `If router said "ROUTE_${t.id}: COMPLETE", exit immediately.`,
        `If "ROUTE_${t.id}: NEEDS_FIX", read SIGNOFF: INCOMPLETE gaps and address every one in ${workdir(t)}.`,
        '',
        `After fixes: cd ${workdir(t)} && ${t.typecheckCmd} && ${t.testCmd}.`,
        '',
        'Do not edit unrelated files. Do not add new TODOs. Exit cleanly.',
      ].join('\n'),
      verification: { type: 'exit_code' },
    });
  }

  // ============================================================
  // Phase 19 — Final signoff after round-2 fix.
  // ============================================================
  for (const t of TRACKS) {
    wf.step(`signoff-final-${t.id.toLowerCase()}`, {
      agent: 'signoff',
      dependsOn: t.commentOnly
        ? [`router-${t.id.toLowerCase()}`]
        : [`fix-r2-${t.id.toLowerCase()}`],
      task: [
        `FINAL signoff for Track ${t.id} after round-2 fix.`,
        '',
        'Re-verify acceptance bullets against the ACTUAL files now.',
        '',
        `Spec section: "${t.specSection}".`,
        '',
        t.commentOnly ? '' : `Diff: cd ${workdir(t)} && git diff origin/main`,
        '',
        'Emit:',
        `  SIGNOFF_FINAL: COMPLETE Track-${t.id}`,
        'or',
        `  SIGNOFF_FINAL: INCOMPLETE Track-${t.id}`,
        '  - <gap>',
        '',
        'Even if INCOMPLETE, exit cleanly. The PR will ship as DRAFT with the gap list.',
      ].join('\n'),
      verification: { type: 'output_contains', value: 'SIGNOFF_FINAL' },
    });
  }

  // ============================================================
  // Phase 20 — Build PR body (deterministic) with loud-hole +
  // signoff + gate output + reflection report.
  // ============================================================
  for (const t of TRACKS) {
    if (t.commentOnly) continue;
    const id = t.id.toLowerCase();
    wf.step(`build-pr-body-${id}`, {
      type: 'deterministic',
      dependsOn: [`signoff-final-${id}`],
      command: [
        'set -e',
        `mkdir -p ${ARTIFACTS}/track-${id}`,
        `BODY=${ARTIFACTS}/track-${id}/pr-body.md`,
        `cat <<'SF_EOF' > ${ARTIFACTS}/track-${id}/signoff-final.txt`,
        `{{steps.signoff-final-${id}.output}}`,
        'SF_EOF',
        `cat <<'FG_EOF' > ${ARTIFACTS}/track-${id}/final-gate.txt`,
        `{{steps.final-gate-${id}.output}}`,
        'FG_EOF',
        `cat <<'RF_EOF' > ${ARTIFACTS}/track-${id}/reflect.txt`,
        `{{steps.reflect-${id}.output}}`,
        'RF_EOF',
        `if grep -q "^SIGNOFF_FINAL: COMPLETE Track-${t.id}" ${ARTIFACTS}/track-${id}/signoff-final.txt; then`,
        `  HEADER_STATE="complete"`,
        `else`,
        `  HEADER_STATE="incomplete"`,
        `fi`,
        `if [ "$HEADER_STATE" = "complete" ]; then`,
        `  printf "%s\\n" "## Summary" "" "- Track ${t.id}: ${t.specSection}" "- Final signoff: COMPLETE." "- Eligible for auto-merge when CI green and upstream deps merged." "" > "$BODY"`,
        `else`,
        `  printf "%s\\n" "## Summary (DRAFT -- gaps remain)" "" "- Track ${t.id}: ${t.specSection}" "- Final signoff: INCOMPLETE; gap list below." "- PR stays as DRAFT; human review required." "" > "$BODY"`,
        `fi`,
        'printf "%s\\n" "## Spec reference" "" "Source spec: workforce/docs/plans/deploy-v1-schema-cascade-spec.md" "" >> "$BODY"',
        `printf "%s\\n" "Track section: ${t.specSection}" "" >> "$BODY"`,
        'printf "%s\\n" "## Final signoff" "" "\\`\\`\\`" >> "$BODY"',
        `cat ${ARTIFACTS}/track-${id}/signoff-final.txt >> "$BODY"`,
        'printf "%s\\n" "\\`\\`\\`" "" "## Final gate (typecheck + tests)" "" "\\`\\`\\`" >> "$BODY"',
        `cat ${ARTIFACTS}/track-${id}/final-gate.txt >> "$BODY"`,
        'printf "%s\\n" "\\`\\`\\`" "" "## Self-reflection report" "" "\\`\\`\\`" >> "$BODY"',
        `cat ${ARTIFACTS}/track-${id}/reflect.txt >> "$BODY"`,
        'printf "%s\\n" "\\`\\`\\`" "" >> "$BODY"',
        ...LOUD_HOLE_LINES.map((line) => `printf "%s\\n" ${JSON.stringify(line)} >> "$BODY"`),
        'printf "%s\\n" "" "Co-Authored-By: Ricky deploy-v1 schema cascade <noreply@agentworkforce.com>" >> "$BODY"',
        'echo "=== PR BODY for Track ' + t.id + ' ==="',
        'cat "$BODY"',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    });
  }

  // ============================================================
  // Phase 21 — Per-track commit + push (deterministic).
  // ============================================================
  for (const t of TRACKS) {
    if (t.commentOnly) continue;
    wf.step(`commit-push-${t.id.toLowerCase()}`, {
      type: 'deterministic',
      dependsOn: [`build-pr-body-${t.id.toLowerCase()}`],
      command: [
        'set -e',
        `cd ${workdir(t)}`,
        'git add -A',
        'if git diff --cached --quiet; then',
        `  echo "NO_CHANGES_TO_COMMIT_${t.id}"`,
        'else',
        '  MSG=$(mktemp)',
        `  printf "%s\\n" ${JSON.stringify(t.prTitle)} "" ${JSON.stringify(`Track ${t.id}: ${t.specSection}`)} "" ${JSON.stringify('See workforce/docs/plans/deploy-v1-schema-cascade-spec.md')} > "$MSG"`,
        '  git commit -F "$MSG"',
        '  rm -f "$MSG"',
        'fi',
        `git push -u origin ${t.branch} --force-with-lease`,
        'git log --oneline -1',
      ].join('\n'),
      captureOutput: true,
      failOnError: false,
    });
  }

  // ============================================================
  // Phase 22 — Open PR as DRAFT (or reuse existing for rebase tracks).
  // ============================================================
  for (const t of TRACKS) {
    if (t.commentOnly) continue;
    const id = t.id.toLowerCase();
    wf.step(`open-pr-${id}`, {
      type: 'deterministic',
      dependsOn: [`commit-push-${id}`],
      command: [
        'set -e',
        `mkdir -p ${ARTIFACTS}/track-${id}`,
        `EXISTING=$(gh pr list --repo ${t.ghRepo} --head ${t.branch} --state open --json number -q '.[0].number' 2>/dev/null || echo "")`,
        'if [ -n "$EXISTING" ]; then',
        `  echo "Track ${t.id}: reusing existing PR #$EXISTING"`,
        `  echo "$EXISTING" > ${ARTIFACTS}/track-${id}/pr-number.txt`,
        `  gh pr edit "$EXISTING" --repo ${t.ghRepo} --body-file ${ARTIFACTS}/track-${id}/pr-body.md || true`,
        'else',
        `  CREATED=$(gh pr create --repo ${t.ghRepo} --head ${t.branch} --base main --draft --title ${JSON.stringify(t.prTitle)} --body-file ${ARTIFACTS}/track-${id}/pr-body.md 2>&1 || echo "FAILED")`,
        '  PR_NUM=$(echo "$CREATED" | grep -oE "/pull/[0-9]+" | grep -oE "[0-9]+" | head -1)',
        '  if [ -n "$PR_NUM" ]; then',
        `    echo "Track ${t.id}: created PR #$PR_NUM"`,
        `    echo "$PR_NUM" > ${ARTIFACTS}/track-${id}/pr-number.txt`,
        '  else',
        `    echo "Track ${t.id}: PR create failed: $CREATED"`,
        `    echo "" > ${ARTIFACTS}/track-${id}/pr-number.txt`,
        '  fi',
        'fi',
      ].join('\n'),
      captureOutput: true,
      failOnError: false,
    });
  }

  // ============================================================
  // Phase 23 — Wait for CI green (poll PR checks, 30 min cap).
  // ============================================================
  for (const t of TRACKS) {
    if (t.commentOnly) continue;
    const id = t.id.toLowerCase();
    wf.step(`wait-ci-${id}`, {
      type: 'deterministic',
      dependsOn: [`open-pr-${id}`],
      command: [
        'set -e',
        `PR_NUM=$(cat ${ARTIFACTS}/track-${id}/pr-number.txt 2>/dev/null || echo "")`,
        'if [ -z "$PR_NUM" ]; then',
        `  echo "Track ${t.id}: no PR -- skipping CI wait."`,
        '  exit 0',
        'fi',
        'for i in $(seq 1 60); do',
        `  STATUS=$(gh pr checks "$PR_NUM" --repo ${t.ghRepo} --required --json conclusion -q '[.[] | .conclusion] | unique' 2>/dev/null || echo "[]")`,
        `  echo "Track ${t.id} CI status (iter $i): $STATUS"`,
        '  case "$STATUS" in',
        `    '["SUCCESS"]'|'[]') echo "Track ${t.id} CI: GREEN"; exit 0;;`,
        `    *FAILURE*) echo "Track ${t.id} CI: FAILURE -- stopping cascade for this track."; exit 0;;`,
        `    *CANCELLED*) echo "Track ${t.id} CI: CANCELLED"; exit 0;;`,
        '  esac',
        '  sleep 30',
        'done',
        `echo "Track ${t.id}: CI did not settle within 30 min."`,
        'exit 0',
      ].join('\n'),
      captureOutput: true,
      failOnError: false,
    });
  }

  // ============================================================
  // Phase 24 — Merge-ready check (DAG walk: upstream merged?).
  // Includes external PR deps via gh pr view --json mergedAt.
  // ============================================================
  for (const t of TRACKS) {
    if (t.commentOnly) continue;
    const id = t.id.toLowerCase();
    const upstreamMerges = t.mergeAfter
      .filter((dep) => !trackById(dep).commentOnly)
      .map((dep) => `auto-merge-${dep.toLowerCase()}`);
    wf.step(`merge-ready-${id}`, {
      type: 'deterministic',
      dependsOn: [`wait-ci-${id}`, ...upstreamMerges],
      command: mergeReadyCmd(t),
      captureOutput: true,
      failOnError: false,
    });
  }

  // ============================================================
  // Phase 25 — Auto-merge gate: flip draft -> ready, squash --auto.
  // Blocks on CHANGES_REQUESTED, unresolved comments, upstream not merged.
  // ============================================================
  for (const t of TRACKS) {
    if (t.commentOnly) continue;
    const id = t.id.toLowerCase();
    wf.step(`auto-merge-${id}`, {
      type: 'deterministic',
      dependsOn: [`merge-ready-${id}`],
      command: autoMergeCmd(t),
      captureOutput: true,
      failOnError: false,
    });
  }

  // ============================================================
  // Phase 26 — Final cross-cascade summary (the wake-up report).
  // ============================================================
  const finalDeps = TRACKS.filter((t) => !t.commentOnly).map(
    (t) => `auto-merge-${t.id.toLowerCase()}`,
  );
  wf.step('final-cascade-report', {
    type: 'deterministic',
    dependsOn: finalDeps.length > 0 ? finalDeps : ['read-spec'],
    command: [
      'set -e',
      `mkdir -p ${ARTIFACTS}`,
      `REPORT=${ARTIFACTS}/wake-up-report.md`,
      'printf "%s\\n" "# Deploy v1 schema cascade -- wake-up report" "" "Generated by ricky-deploy-v1-schema-cascade workflow." "" "## Per-track merge state" "" > "$REPORT"',
      ...TRACKS.filter((t) => !t.commentOnly).map(
        (t) =>
          `STATE=$(cat ${ARTIFACTS}/track-${t.id.toLowerCase()}/merge-state.txt 2>/dev/null || echo "UNKNOWN"); PR=$(cat ${ARTIFACTS}/track-${t.id.toLowerCase()}/pr-number.txt 2>/dev/null || echo "?"); printf -- "- Track ${t.id} (${t.repo}): %s -- PR #%s\\n" "$STATE" "$PR" >> "$REPORT"`,
      ),
      'printf "\\n%s\\n\\n" "## Comment-only tracks" >> "$REPORT"',
      ...TRACKS.filter((t) => t.commentOnly).map(
        (t) => `printf -- "- Track ${t.id}: comment-only -- see signoff\\n" >> "$REPORT"`,
      ),
      'printf "\\n%s\\n\\n" "## Loud holes still open (intentional)" >> "$REPORT"',
      ...LOUD_HOLE_LINES.map((line) => `printf "%s\\n" ${JSON.stringify(line)} >> "$REPORT"`),
      'echo "=== WAKE-UP REPORT ==="',
      'cat "$REPORT"',
    ].join('\n'),
    captureOutput: true,
    failOnError: false,
  });

  // ============================================================
  // Global error policy: retry transient failures up to 2x with 10s
  // backoff (writing-agent-relay-workflows SKILL convention).
  // ============================================================
  wf.onError('retry', { maxRetries: 2, retryDelayMs: 10_000 });

  const result = await wf.run({ cwd: process.cwd() });
  console.log('Workflow status:', result.status);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
