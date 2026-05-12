# Plan — `workforce deploy` v1

Status: draft for review
Owner: workforce
Target: shipped today (Phase 1 vertical slice)
Depends on: cloud proactive-runtime M1 (assumed shipping today), Daytona creds in workforce cloud env

---

## 1. Thesis

A workforce **persona is a deployable agent**. Today a persona JSON describes how to launch a harness in the user's terminal. After this work, the same persona JSON — with a few new fields — also describes a cloud agent that listens for events (GitHub PR opened, Linear issue created, `@mention`, cron tick), runs inside a Daytona sandbox, can invoke its harness for real work, retains memory, and posts back through Slack/Relaycast/GitHub.

The user-facing command is one line:

```
workforce deploy ./review-agent.json
```

That command does everything: validates schema, prompts the user through integration OAuth, registers triggers, bundles the agent code, and starts a long-lived runner. The persona JSON is the single source of truth.

This unifies three product surfaces that today live as separate things:
- The local persona/harness story (`workforce agent <id>`)
- The sage-style addressable assistant (Slack/Relaycast inbox)
- The proactive-agents-style scheduled/event-driven worker

One file. One command. One contract.

---

**Companion docs:**
- `workforce/docs/plans/deploy-v1-workflow-spec.md` — Ricky cross-repo execution spec (worktree layout, branch names, PR templates, blocked tracks).
- `workforce/docs/plans/deploy-v1-codex-spec.md` — parallel codex implementer tasks (do not duplicate from this plan).

---

## 2. Scope cut for today

### In

- Persona JSON schema extension: `cloud`, `useSubscription`, `integrations`, `schedules`, `sandbox`, `memory`, `traits`, `onEvent`.
- New package `@agentworkforce/runtime` — thin facade exposing `handler(...)` that wraps `agent({...})` from `@agent-relay/agent` (cloud proactive-runtime M1 SDK).
- New package `@agentworkforce/deploy` — the deploy CLI logic; the existing `cli.ts` gets a `deploy` case that dispatches to it.
- Daytona sandbox launcher used in the `--sandbox` run mode.
- Integration connect via `@relayfile/sdk` (`RelayfileSetup.connectIntegration`) and provider connect via `@agent-relay/cloud` (`connectProvider`) when `useSubscription: true`.
- Run modes:
  - `--dev` — long-lived local Node process connecting to `agent-gateway` (no sandbox).
  - `--sandbox` — Daytona sandbox runs the bundle; default when Daytona creds resolve.
  - `--cloud` — POST bundle to a workforce cloud deploy endpoint. **Stubbed today** (endpoint lands in proactive-runtime M4). The flag exists, prints "not yet available; cloud-hosted deploy lands with M4."
- Two reference examples shipped in `examples/`:
  - `examples/review-agent/` — GitHub PR review + autofix
  - `examples/weekly-digest/` — cron, Brave search → GitHub issue
- `workforce dry-run` extension that validates the new fields and lints the integration trigger names.

### Out (Phase 2+)

- Declarative integration routing (`links: [{ from: "github.issue.opened", to: "slack.post" }]`). Linking happens in `onEvent` code for v1.
- Multi-tenant cloud-hosted deploy (blocked on cloud proactive-runtime M4).
- Persona schema for "personas as a service" marketplace metadata (pricing, install count, etc.).
- A web UI for managing deployed agents — CLI only for now.
- Migrating sage / sales / nightcto to this contract — they remain as-is; this is greenfield.

---

## 3. Persona JSON schema diff

All new fields are optional. A persona that does not set any of them continues to behave exactly as today — `workforce agent <id>` works unchanged. Set `cloud: true` and at least one trigger to opt into the new deploy surface.

### 3.1 Top-level additions

| Field | Type | Required when | Meaning |
|---|---|---|---|
| `cloud` | `boolean` | always (default `false`) | When `true`, this persona is deployable. `workforce deploy` only operates on personas where this is `true`. |
| `useSubscription` | `boolean` | optional | When `true`, inference uses the user's connected LLM subscription via `@agent-relay/cloud`'s provider link (no workforce-billed tokens). Triggers a `connectProvider` step at deploy time. |
| `integrations` | `Record<string, IntegrationConfig>` | when persona has event triggers | Declares which Relayfile providers this agent needs and what events fire its handler. See §3.2. |
| `schedules` | `Schedule[]` | when persona runs on cron | One or more cron triggers, registered with the runtime's `ctx.schedule.every(...)`. Each schedule has a `name` echoed back to the handler. See §3.3. |
| `sandbox` | `boolean \| SandboxConfig` | optional | `true` (default) means agent runs inside a Daytona sandbox. `false` means the runner process owns its own filesystem. Object form lets you tune env / timeout. See §3.4. |
| `memory` | `boolean \| MemoryConfig` | optional | Enables the agent-assistant memory subsystem. Scopes and TTL configurable. See §3.5. |
| `traits` | `Traits` | optional, **only meaningful for interactive agents** | Mirrors `@agent-assistant/traits`: voice, formality, proactivity, etc. Applied when the agent posts to a chat surface (Slack, Relaycast). Headless agents (paraglide-style "Linear issue → ship") may omit this. See §3.6. |
| `onEvent` | `string` | when `cloud: true` and any trigger declared | Path to a TS file (relative to the persona JSON) whose default export is the event handler. Sub-file references like `./agent.ts` and `./handlers/index.ts` are supported. See §4. |

### 3.2 `integrations` shape

```jsonc
"integrations": {
  "github": {
    "scope": { "repo": "AgentWorkforce/workforce" },          // optional; provider-specific filter
    "triggers": [
      { "on": "pull_request.opened" },
      { "on": "issue_comment.created", "match": "@mention" }, // match is a sugar lint, see §3.7
      { "on": "pull_request_review_comment.created" },
      { "on": "check_run.completed", "where": "conclusion=failure" }
    ]
  },
  "linear": { "triggers": [{ "on": "issue.created" }] },
  "slack":  { "triggers": [{ "on": "app_mention" }] },
  "notion": { "scope": { "database": "..." }, "triggers": [{ "on": "page.updated" }] }
}
```

Key choices:
- **Key is the Relayfile provider slug.** `github`, `linear`, `slack`, `notion`, `jira`. The deploy step calls `RelayfileSetup.connectIntegration({ allowedIntegrations: [key] })` for any provider not yet connected to the user's workspace.
- **`triggers[]` is a flat list per provider** — multiple events from the same provider all fan into the same `onEvent`. The handler discriminates on `event.source` + `event.type`.
- **`match` and `where` are sugars** — `match: "@mention"` is shorthand for "filter to events that mention the deployed agent." The deploy CLI lints them against a known set; unknown values warn but don't fail. We can always upgrade the runtime to enforce them later.
- **`scope` is optional and provider-specific.** Validated by the deploy CLI against a small provider-schema map. For v1, supported keys are documented per provider in the examples.

The act of stacking integrations is just declaring multiple keys. The act of linking them ("when GitHub fires, post to Slack") is code in `onEvent`. We considered a declarative `links:` block — see §11.4 for why we deferred it.

### 3.3 `schedules` shape

```jsonc
"schedules": [
  { "name": "weekly-digest", "cron": "0 9 * * 6", "tz": "UTC" },
  { "name": "stale-prs",    "cron": "0 9 * * 1-5", "tz": "America/New_York" }
]
```

- `name` is required and unique within the persona; it surfaces as `event.name` to disambiguate inside `onEvent`.
- `cron` is a standard 5-field expression. `tz` defaults to `UTC`.
- Multiple schedules are allowed. The runtime registers each with `ctx.schedule.every(cron, { tz, payload: { name } })`.

### 3.4 `sandbox` shape

```jsonc
"sandbox": true                                          // default
"sandbox": { "enabled": true, "timeoutSeconds": 1800, "env": { "FOO": "bar" } }
"sandbox": false                                         // run in the runner process's fs
```

- Image is **not** user-configurable in v1. Workforce picks a standard image (`node-22` baseline) for the default Daytona sandbox. We can add `image` later if a real demand surfaces; eliminating the field keeps the v1 contract small.
- `timeoutSeconds` caps a single handler invocation. Default 1800s.
- `env` adds env vars on top of the auto-injected secrets (Relayfile connection tokens, harness inference creds, etc.).
- When `sandbox: false`, the agent's `ctx.sandbox` still exists but points at the runner's own process — useful for `--dev` iteration, **not** what we recommend for production.

### 3.5 `memory` shape

```jsonc
"memory": true                                            // sensible defaults
"memory": {
  "enabled": true,
  "scopes": ["session", "user", "workspace"],
  "ttlDays": 30,
  "autoPromote": true,
  "dedupMs": 300000
}
```

- Implementation: the runtime wires `@agent-assistant/memory` with the supermemory adapter (matching sage today). API key is pulled from workforce-managed env, not declared in the persona.
- `scopes` is the only field with real semantic weight: session-only memory is wiped per handler; user-scope persists across the user's invocations of this agent; workspace persists across all users.
- `autoPromote` flips on the sage turn-recorder pattern — agent decides if session content is worth promoting.
- **No `memoryMd` file.** Memory is config, not prose. Personality goes in `traits` and `description`.

### 3.6 `traits` shape

Direct mapping to `@agent-assistant/traits`:

```jsonc
"traits": {
  "voice": "professional-warm",
  "formality": "low",
  "proactivity": "medium",
  "riskPosture": "conservative",
  "domain": "engineering",
  "vocabulary": ["PR", "diff", "CI"],
  "preferMarkdown": true
}
```

Only used when the runtime renders into a conversational surface (Slack message, Relaycast post, GitHub PR comment). Skip the field entirely for headless agents — saves the runtime a subsystem registration.

### 3.7 Trigger-name registry

`packages/persona-kit/src/triggers.ts` (new) ships a small registry of known trigger names per provider so the deploy CLI can lint them:

```ts
export const KNOWN_TRIGGERS = {
  github: ["pull_request.opened", "pull_request.synchronize",
           "issue_comment.created", "pull_request_review_comment.created",
           "check_run.completed", "workflow_run.completed", "issues.opened"],
  linear: ["issue.created", "issue.updated", "comment.created"],
  slack:  ["app_mention", "message.channels"],
  // ...
} as const;
```

Unknown trigger names log a yellow warning but don't fail deploy. The cloud runtime is the source of truth; we don't want to be a gating bottleneck.

---

## 4. Runtime substrate — `@agentworkforce/runtime`

A new, intentionally thin package. Single export: `handler(...)`.

```ts
// @agentworkforce/runtime
import { agent } from '@agent-relay/agent'; // PR #515 M1

type WorkforceEvent =
  | { source: 'cron'; name: string; firedAt: string }
  | { source: 'github'; type: GithubTrigger; ...payload }
  | { source: 'linear'; type: LinearTrigger; ...payload }
  | { source: 'slack'; type: SlackTrigger; ...payload };

interface WorkforceCtx {
  // Inference, either workforce-billed or via the user's subscription
  llm: { complete(prompt: string, opts?: LlmOpts): Promise<string> };

  // Spawn the persona's declared harness inside the sandbox
  harness: {
    run(args: { prompt: string; cwd?: string; tier?: 'best'|'best-value'|'minimum' }): Promise<HarnessResult>;
  };

  // Per-integration auth-wrapped clients (only those declared in persona.integrations)
  github?:  GithubClient;
  linear?:  LinearClient;
  slack?:   SlackClient;
  notion?:  NotionClient;
  jira?:    JiraClient;

  // Daytona sandbox (or process fs if sandbox:false)
  sandbox: {
    cwd: string;                                          // absolute path inside the sandbox
    exec(cmd: string, opts?: { cwd?: string; env?: Record<string,string> }): Promise<ExecResult>;
    readFile(path: string): Promise<string>;
    writeFile(path: string, contents: string): Promise<void>;
  };

  // Memory (agent-assistant memory, wired per persona.memory)
  memory: {
    save(content: string, opts?: { tags?: string[]; scope?: MemoryScope }): Promise<void>;
    recall(query: string, opts?: { limit?: number }): Promise<MemoryItem[]>;
  };

  // Workflow invocation — the persona-as-orchestrator escape hatch (§6)
  workflow: {
    run(name: string, args: Record<string, unknown>): Promise<WorkflowRunHandle>;
  };

  // Schedule control — for handlers that want to schedule one-off followups
  schedule: {
    at(when: Date, payload: unknown): Promise<void>;
    cancel(name: string): Promise<void>;
  };

  // Persona metadata (id, traits, harness tier defaults, etc.) — read-only
  persona: PersonaSpec;
}

export function handler<I extends IntegrationKeys>(
  fn: (ctx: WorkforceCtx & { [k in I]: NonNullable<WorkforceCtx[k]> }, event: WorkforceEvent) => Promise<void>
): WorkforceHandler;
```

Implementation notes:
- `handler(...)` reads the persona JSON adjacent to the entrypoint (workforce bundles them together). At cold-start it:
  1. Calls `agent({ workspace, schedule, watch, inbox, onEvent: shim })` from `@agent-relay/agent`, mapping `persona.integrations` to `watch` and `persona.schedules` to `schedule`.
  2. Builds `ctx` once per agent boot: opens Daytona handle (if `sandbox: true`), wires Relayfile-derived clients, attaches memory adapter.
  3. The `shim` reshapes the raw envelope from `@agent-relay/agent` into the `WorkforceEvent` discriminated union and invokes the user's `fn(ctx, event)`.
- The user never imports `@agent-relay/agent` directly. Workforce owns the ergonomics. If the underlying SDK churns, we absorb the diff here.
- The SDK doors stay open for power users: we re-export `agent` from `@agentworkforce/runtime/raw` so anyone who wants the lower-level surface can drop down. This matters for nightcto-shaped projects that outgrow the persona contract.

The runtime package has **zero runtime dependencies on the CLI**. It can be installed standalone in any Node project to write an agent without `workforce deploy`. That keeps the personas-as-code escape hatch clean.

---

## 5. Deploy CLI — `@agentworkforce/deploy`

New package. Exports `deploy(persona, opts): Promise<DeployResult>`. The existing `packages/cli/src/cli.ts` adds:

```ts
case 'deploy': await runDeploy(argv); break;
case 'login':  await runLogin(argv);  break;   // small new helper for cloud auth
```

`runDeploy` is a ~150-line orchestrator over the deploy package. Public flags:

```
workforce deploy <persona-path>
    [--mode dev|sandbox|cloud]            # default: sandbox if Daytona creds present, else dev
    [--workspace <name>]                  # workforce workspace; defaults to active
    [--no-connect]                        # skip integration prompts; fail if any are missing
    [--detach]                            # background the runner
    [--bundle-out <dir>]                  # emit bundle without launching
    [--dry-run]                           # validate only
```

Flow:

1. **Resolve persona**: load the JSON via `parsePersonaSpec` (extended schema). Fail fast on schema errors with field-pointed messages.
2. **Login check**: if no workforce auth token in keychain, prompt `workforce login` (browser OAuth via existing relayauth flow).
3. **Workspace check**: ensure user has a workspace; offer to create one (`relay workspaces create <name>` semantics, called via SDK not subprocess).
4. **Integrations**: for each `persona.integrations` key, check if connected to the active workspace. If not, **prompt the user before each** (`Connect github now? (Y/n)`). On yes, call `RelayfileSetup.connectIntegration({ allowedIntegrations: [key] })` and open the browser. Block until callback. On no, fail with a clear message.
5. **Subscription** (if `useSubscription: true`): call `connectProvider({ provider: <persona.tiers.best.harness derived> })` from `@agent-relay/cloud`. Pick provider from the persona's primary tier harness (claude → anthropic, codex → openai, opencode → user choice).
6. **Schedules**: register each `persona.schedules[i]` with the runtime — for `--dev` and `--sandbox`, schedules are registered via the runtime SDK at boot; for `--cloud` (when M4 lands), they're part of the bundle metadata.
7. **Bundle**: stage to `.workforce/build/<persona-id>/`:
   - `persona.json` (the spec)
   - `agent.ts` (the user's `onEvent` file, possibly transpiled)
   - `runner.ts` (generated; calls `handler(...)` and starts the runtime)
   - `package.json` (with `@agentworkforce/runtime` and any user-declared deps)
8. **Launch**:
   - `--dev`: `node .workforce/build/<id>/runner.ts` in the foreground (or detached).
   - `--sandbox`: spin up Daytona sandbox, upload the bundle, `daytona.exec("node runner.ts")`. Stream logs back to stdout.
   - `--cloud`: print "not yet available; cloud-hosted deploy lands with proactive-runtime M4." Bundle is left in `.workforce/build/` for inspection.
9. **Print status**: agent ID, workspace, integrations connected, schedules registered, runner mode, log tail command.

`--bundle-out <dir>` writes the bundle and exits. Useful for CI and for the future `--cloud` mode.
`--dry-run` validates schema + lints triggers + checks integration connection status, no side effects.

---

## 6. Harness + workflow bridge

The user explicitly asked: "within the harness definition can we call for a workflow to be run?"

Two levels of integration:

### 6.1 Harness as an LLM-driven tool runner

When `onEvent` calls `ctx.harness.run({ prompt: "Review this diff", cwd: ctx.sandbox.cwd })`, the runtime spawns the persona's declared tier (claude/codex/opencode) **inside** the sandbox, with the sandbox cwd as the harness's working directory. The harness has:
- Filesystem access to the sandbox's mounted workspace.
- Network access per the persona's `harnessSettings` (`workspaceWriteNetworkAccess`).
- The persona's declared `skills`, `mcpServers`, and `permissions` materialized as the harness expects.
- Optionally, an MCP server we ship — `mcp__workforce` — exposing `workflow.run`, `memory.save`, `memory.recall`, and the per-integration clients. The harness can call these as tools mid-run, without re-architecting around the workforce SDK.

That's how a "review PR" handler can let Claude Code (or Codex) drive the entire review autonomously: the handler hands the harness the diff, the harness reads files, runs tests in the sandbox, drafts comments, and returns. The handler then posts the comments via `ctx.github.comment`.

### 6.2 Workflows as first-class invocations

`ctx.workflow.run("name", args)` is the escape hatch for the heavy machinery in `cloud/workflows`. Inside a handler — or from within the harness via the `mcp__workforce` MCP — you can kick off a multi-step workflow. The workflow runs in cloud (its native habitat) and returns a handle; the handler can `await handle.completion()` or fire-and-forget.

Examples:
- `review-agent` invokes a `pr-review-multi-tier` workflow that runs three independent reviewers and synthesizes.
- `My-Senior-Dev`-shaped agents invoke `code-explore` + `propose-edits` + `verify` workflows in sequence.

For v1 the workflow client is a thin HTTP wrapper around the cloud workflows endpoint. Authentication piggybacks on the workspace token already loaded for `agent-gateway`.

This is the bridge: **personas declare** the integration surface and the handler; **handlers orchestrate**; **workflows execute**. None of these need to know about the others' internals.

---

## 7. Examples to ship today

### 7.1 `examples/weekly-digest/`

Direct port of the proactive-agents weekly-digest pattern.

`persona.json`:
```json
{
  "id": "weekly-digest",
  "intent": "research",
  "tags": ["analytics"],
  "description": "Weekly competitive intel digest — searches the web and Reddit for mentions, dedupes, posts a single GitHub issue.",
  "cloud": true,
  "integrations": { "github": { "scope": { "repo": "AgentWorkforce/weekly-digest" } } },
  "schedules": [{ "name": "weekly", "cron": "0 9 * * 6", "tz": "UTC" }],
  "sandbox": true,
  "memory": { "enabled": true, "scopes": ["workspace"], "ttlDays": 90 },
  "onEvent": "./agent.ts",
  "tiers": { ... standard codex/opencode tiers ... }
}
```

`agent.ts`: ~80 lines. Brave search → cluster → upsert GitHub issue.

### 7.2 `examples/review-agent/`

`persona.json`:
```json
{
  "id": "review-agent",
  "intent": "review",
  "tags": ["review"],
  "description": "Reviews opened PRs, responds to @mentions in comments, attempts autofix on red CI.",
  "cloud": true,
  "useSubscription": true,
  "integrations": {
    "github": {
      "triggers": [
        { "on": "pull_request.opened" },
        { "on": "issue_comment.created", "match": "@mention" },
        { "on": "pull_request_review_comment.created" },
        { "on": "check_run.completed", "where": "conclusion=failure" }
      ]
    },
    "slack": { "triggers": [{ "on": "app_mention" }] }
  },
  "sandbox": true,
  "memory": { "enabled": true, "scopes": ["session", "workspace"] },
  "traits": { "voice": "professional-warm", "formality": "low", "preferMarkdown": true },
  "onEvent": "./agent.ts",
  "tiers": { ... }
}
```

`agent.ts`: ~120 lines. Dispatches on `event.type`:
- `pull_request.opened` → `ctx.harness.run({ prompt: "Review", cwd })` → post review
- `issue_comment.created` + `@mention` → harness with thread context → reply
- `check_run.completed` + failure → harness with logs → propose fix patch
- `slack.app_mention` → conversational reply using memory

---

## 8. Package layout — diff

```
workforce/
├── packages/
│   ├── cli/                          # add `deploy`, `login` cases
│   ├── persona-kit/                  # extend PersonaSpec schema (§3)
│   │   └── src/
│   │       ├── types.ts              # +CloudFields, +IntegrationConfig, +Schedule, +Sandbox, +Memory, +Traits
│   │       ├── parse.ts              # extend parsePersonaSpec to read new fields
│   │       └── triggers.ts           # NEW — known triggers registry (§3.7)
│   ├── harness-kit/                  # no changes for v1
│   ├── workload-router/              # no changes for v1
│   ├── deploy/                       # NEW — @agentworkforce/deploy
│   │   └── src/
│   │       ├── index.ts              # deploy(persona, opts) entry
│   │       ├── login.ts              # workspace login helper
│   │       ├── connect.ts            # integration + provider connect orchestration
│   │       ├── bundle.ts             # stage bundle to .workforce/build/<id>
│   │       ├── modes/
│   │       │   ├── dev.ts            # local long-lived process
│   │       │   ├── sandbox.ts        # Daytona launch
│   │       │   └── cloud.ts          # M4-stub
│   │       └── daytona.ts            # thin Daytona wrapper (or import from cloud)
│   └── runtime/                      # NEW — @agentworkforce/runtime
│       └── src/
│           ├── index.ts              # exports handler(), types
│           ├── ctx.ts                # builds WorkforceCtx per invocation
│           ├── clients/              # per-integration auth-wrapped clients
│           │   ├── github.ts
│           │   ├── linear.ts
│           │   ├── slack.ts
│           │   └── ...
│           ├── memory.ts             # wraps @agent-assistant/memory
│           ├── workflow.ts           # cloud workflows HTTP client
│           ├── shim.ts               # @agent-relay/agent envelope → WorkforceEvent
│           └── raw.ts                # re-exports for power users
├── examples/
│   ├── weekly-digest/                # NEW
│   │   ├── persona.json
│   │   └── agent.ts
│   └── review-agent/                 # NEW
│       ├── persona.json
│       └── agent.ts
└── docs/
    └── plans/
        └── deploy-v1.md              # this file
```

Persona schema diffs are non-breaking. Existing personas in `personas/persona-maker.json` etc. continue to work unchanged.

---

## 9. Work split

You asked for an explicit multi-faceted split. Here's the breakdown.

### 9.1 I implement directly (this session)

The work that needs codebase fluency, schema decisions, and inline iteration:

1. **Schema diff in `persona-kit`** — `types.ts`, `parse.ts`, `triggers.ts`. Includes unit tests for the new field shapes.
2. **`@agentworkforce/runtime` skeleton** — `index.ts`, `ctx.ts`, `shim.ts`, types. Stubs for clients/memory/workflow that compile and return typed placeholders. Actual client implementations slotted in via §9.2 / §9.3.
3. **`@agentworkforce/deploy` skeleton** — `index.ts`, `bundle.ts`, `modes/dev.ts` (the simplest run mode). Login + connect orchestration with `--no-connect` fallback for testing.
4. **CLI wiring** — `deploy` and `login` cases in `cli.ts`, plus `--dry-run` and `--bundle-out` flags.
5. **`examples/weekly-digest/`** — fully working against the `--dev` runner. End-to-end demo path.
6. **`examples/review-agent/`** — persona JSON + agent.ts skeleton; full behavior depends on per-integration clients (see §9.2).
7. **Docs** — extend `README.md` with a `## Deploying agents` section pointing at the examples.

Estimate: aggressive 4–6 hours given existing surface area.

### 9.2 Workflow (Ricky) — cross-repo PRs

Full execution detail lives in `deploy-v1-workflow-spec.md`. This plan owns the *what*; the workflow spec owns the *how*.

**Ready-now tracks (one PR per track, all in one Ricky workflow run):**
- **Track A** — extract `@workforce/daytona-runner` + add `POST /api/v1/workspaces/:id/sandboxes` in `$CLOUD_REPO`.
- **Track B** — workforce consumes `@workforce/daytona-runner` + workforce-managed sandbox auth path.
- **Track C** — `@agentworkforce/mcp-workforce` MCP server (workflow/memory/integration tools).
- **Track INT** — cross-repo E2E (`weekly-digest --mode dev`, `review-agent --mode sandbox`, optional `linear-shipper`).

**Blocked tracks (separate workflow files when unblocked):**
- **Track CLOUD** — `--cloud` mode wiring (blocked on cloud proactive-runtime M4).
- **Track BILL** — billing meter for workforce-managed sandboxes (post-v1).
- **Track DOCS** — documentation site updates (after codex Tasks 6/7/9 + human schema-diff merge).

If a track slips, §10's fallback applies: ship `--dev` end-to-end with `weekly-digest`; `review-agent` becomes next-milestone.

### 9.3 Codex agent (independent, parallelizable)

Tasks that are mechanical, well-specified, and don't gate on my decisions — perfect for a codex agent spawned via `workforce agent code-implementer` or a similar persona:

1. **Trigger registry expansion** — fill out `packages/persona-kit/src/triggers.ts` with the full set of known trigger names per Tier-1 provider (Linear, GitHub, Slack, Notion, Jira) by reading the Relayfile provider docs in `/Users/khaliqgant/Projects/AgentWorkforce/relayfile/docs/`.
2. **Test fixtures** — generate sample `persona.json` files exercising every optional combination (with/without traits, sandbox false, multi-schedule, etc.) into `packages/persona-kit/src/__fixtures__/`.
3. **JSON Schema export** — emit a JSON Schema from the extended `PersonaSpec` for editor autocomplete. New script: `packages/persona-kit/scripts/emit-schema.mjs`. Wire to `pnpm run build` so it ships with the package.
4. **Example expansion** — write a third example, `examples/linear-shipper/` (the paraglide pattern: Linear issue created → drive to PR), purely against the runtime substrate I land in §9.1.
5. **README polish** — once the deploy command is real, codex agent rewrites the workforce README to lead with the deploy story.

Each item is a self-contained PR for codex to handle in parallel with my main thread.

---

## 10. Today's milestones (chronological)

| When | Milestone | Owner | Gates |
|---|---|---|---|
| T+0 | Plan reviewed + signed off | user | this doc |
| T+30m | Persona schema diff merged-to-branch | me | typechecks green, fixtures pass |
| T+1h | `@agentworkforce/runtime` skeleton compiles | me | runtime imports + `handler()` types check |
| T+2h | `@agentworkforce/deploy` `--dev` end-to-end | me | `workforce deploy examples/weekly-digest/persona.json --mode dev` runs and logs cron tick |
| T+2.5h | `examples/weekly-digest` posts to a real test GitHub repo | me | demo-ready |
| T+3h | `--sandbox` Daytona mode lights up | me + workflow | depends on Daytona-runner-package PR landing |
| T+4h | `review-agent` example end-to-end against a test PR | me + workflow | depends on per-integration clients |
| T+5h | Codex-agent tasks merged | codex agent | parallel tracks |
| EOD | PR opened, draft for review | me | final pass, screenshots, README |

If §9.2 (Daytona-runner-package + per-integration clients) slips, we ship `--dev` only and demo weekly-digest end-to-end. `review-agent` becomes "next milestone" — but the persona contract still ships.

---

## 11. Open questions / risks

### 11.1 Cloud proactive-runtime M1 timing

Plan assumes `@agent-relay/agent` (M1's SDK) is importable today. If M1 is in flight but not yet published, the runtime substrate falls back to a temporary shim that talks to `agent-gateway` over a hand-rolled WebSocket using the M1 spec's envelope shape. This is a half-day of extra work and an explicit tech-debt note. **Verify before T+0.**

### 11.2 Daytona auth — BYO and workforce-managed, both v1

Two paths, both ship in v1:

- **BYO**: if `DAYTONA_API_KEY` is set in the user's env, the CLI uses it directly. Zero cloud dependency. Useful for power users / CI.
- **Workforce-managed**: if not set, the CLI calls `POST /api/v1/workspaces/:id/sandboxes` against the cloud API with the user's workspace token. Cloud holds the org-level `DAYTONA_API_KEY` (already exists as an SST secret at `cloud/infra/secrets.ts:23`), calls `daytona.create()`, returns `{ sandboxId, jwtToken, organizationId, expiresAt }`. The CLI then constructs a Daytona client with `{ jwtToken, organizationId }` — auth path the SDK already supports (see `cloud/packages/core/src/auth/credentials.ts`).

This used to be deferred to a follow-up; it isn't. The endpoint is ~30 lines on the cloud side, it reuses primitives that already exist, and it removes the need to document "you also need a Daytona account" in the v1 quickstart. Moved into Ricky's M1 (Milestone 1) so it ships alongside the Daytona runner extract.

**Long-lived process lifecycle (verified):** `DaytonaRuntime` does not auto-destroy. Cloud's executor calls `destroy()` explicitly at step end (`cloud/packages/core/src/executor/executor.ts:1029`). Workforce deploy simply never calls `destroy()` — the sandbox persists until the user runs `workforce deployments destroy <id>` (Milestone 3) or we add an idle-timeout sweeper.

**Restart story (open):** if the runner process inside the sandbox crashes, the OS process dies but the sandbox itself remains. A small supervisor loop inside `runner.mjs` (`while (true) { await runAgent().catch(log) }`) covers transient crashes. If the entire sandbox dies (rare; Daytona-side incident), the CLI's `--detach` mode is fire-and-forget — we'd need a "workforce deployments tail" command later to detect death and re-spin. Acceptable v1 gap.

*Endpoint contract, audit logging, and JWT-vs-proxy fallback are pinned in `deploy-v1-workflow-spec.md` Track A.*

### 11.3 Bundling TS for the sandbox

The `agent.ts` the user authors needs to run in the Daytona sandbox. Three options for the bundler:
- **esbuild** — fast, minimal config. Output a single-file CJS bundle the sandbox's `node runner.js` can execute.
- **tsx at runtime** — install tsx in the sandbox, run `tsx runner.ts` directly. No bundle step.
- **No transpile** — require user `agent.ts` to be pre-built (`pnpm tsc` in the persona dir).

Default to **esbuild**. It's a one-import dependency and gives us deterministic output.

### 11.4 Why no declarative `links:` block

The user's notes had:
> issue opened in github, synced to linear — deterministic
> issue opened in github, slack message sent — deterministic OR agent reviews and summarizes

We considered:
```json
"links": [{ "from": "github.issue.opened", "to": "linear.create", "template": "..." }]
```

Decision: defer. Every "deterministic" route in the wild has filters, conditions, retry semantics, or templated payloads — all of which pull it back toward code. Three lines in `onEvent` is clearer than a config-language with its own escape hatches:

```ts
if (event.source === 'github' && event.type === 'issues.opened') {
  await ctx.linear.create({ title: event.issue.title, body: event.issue.body });
  await ctx.slack.post('#triage', `Issue ${event.issue.url}`);
}
```

If we see N personas repeating the same routing skeleton, we lift it then. Premature abstraction here would lock us into a config shape we'd want to evolve.

### 11.5 Multi-persona deployments

Right now, one persona = one deployable. A user with three agents runs `workforce deploy` three times. That's fine for v1. We may want a `workforce.config.json` listing deployables later, but the implementation should treat that as sugar over the single-persona path.

### 11.6 Local dev story for sandboxed handlers

When the user iterates on `agent.ts`, the `--dev` mode runs the handler in their local process, fast. The `--sandbox` mode pushes to Daytona each restart, slow. We need a `--sandbox --watch` mode that rsync-mirrors local changes into the live sandbox. Stretch goal for today; trivial follow-up if it slips.

### 11.7 Authorization & secrets in `--cloud`

When `--cloud` mode lights up post-M4, the bundle uploaded to cloud must not contain plaintext provider tokens. The Relayfile connection token model already handles this (workspace holds the connection, agents request scoped tokens at runtime). Confirm with the cloud team that M4's accept-bundle endpoint takes a persona JSON + bundled JS only — no secrets baked in.

---

## 12. Out-of-scope rejections (record so we don't drift)

- **Polyglot handlers (`agent.py`, etc.)**: the user's notes mentioned `etc.py`. Phase 2. The runtime's SDK is TS-first; a Python adapter is a substantial extra package.
- **GUI / dashboard for deployed agents**: cloud-side surface, not workforce CLI.
- **Persona marketplace metadata**: pricing, install counts, ratings. Belongs in a future `marketplace` package.
- **Migrating sage / sales / nightcto onto this contract**: they stay as-is. The new substrate proves itself on greenfield agents first.
- **Cross-persona communication (`agent.send-to(other)`)**: relaycast already does this between agents that opt in. The persona JSON doesn't need a new field; `ctx.slack.post(...)` to a workspace channel works today.

---

## 13. Definition of done (today)

A user with:
- A fresh workforce install
- A clean `examples/weekly-digest/persona.json` and `agent.ts`
- Their GitHub workspace connected through `relayfile`

Can run:

```
workforce login
workforce deploy ./examples/weekly-digest/persona.json --mode dev
```

And within 60 seconds see:
- A "Connect github? (Y/n)" prompt if not connected
- "Workspace = my-workspace, persona = weekly-digest, sandbox = on, mode = dev"
- A long-lived process printing `[runtime] cron schedule "weekly" registered`
- On forcing a `cron.tick`, the handler runs and posts a GitHub issue

For `--mode sandbox`, the same flow with logs streaming from a Daytona sandbox.

That's the shippable v1.
