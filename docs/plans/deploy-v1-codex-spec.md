# Codex agent spec — `workforce deploy` v1

You are implementing the parallelizable, mechanical pieces of the `workforce deploy` v1 feature. The product plan lives at `docs/plans/deploy-v1.md` — read it first, top to bottom, for context. **This file is your contract**: do exactly what it specifies, in the listed order of priority, opening one PR per numbered task against the `workforce` repo.

You are working in parallel with a human engineer who owns the schema diff in `persona-kit`, the `@agentworkforce/runtime` core (`handler()` + ctx builder + shim), the deploy orchestrator's main flow, and the CLI dispatch case. **Treat their files as published interfaces — do not modify them.** If something you need is missing, leave a `TODO(human): exposed surface needed — <what>` comment and skip ahead.

## Working agreement

- **Branch per task.** One branch per numbered task. Naming: `codex/deploy-v1-<task-slug>` (e.g. `codex/deploy-v1-github-client`).
- **PR per task.** Title format: `feat(<package>): <task summary>`. Body links back to this spec section.
- **No schema decisions.** If a persona JSON field is ambiguous, re-read §3 of `deploy-v1.md`. If still ambiguous, surface in PR body — do not invent.
- **TypeScript only.** ESM modules. `"type": "module"`. Match existing workforce package style (`packages/persona-kit/package.json` is the reference).
- **No new dependencies without justification.** Prefer extending existing imports. If you need a new dep, state why in the PR body.
- **Tests required.** Each new file must have a `*.test.ts` next to it covering happy path + one error case. Use the existing test runner — check `packages/persona-kit` for the pattern.
- **Run `corepack pnpm run check` before declaring a task done.** If it's red, fix it before opening the PR.

## Interfaces you can rely on (published by the human)

By the time you start, these will exist:

```ts
// from @agentworkforce/persona-kit (extended schema)
import type { PersonaSpec, IntegrationConfig, Schedule, SandboxConfig, MemoryConfig, Traits } from '@agentworkforce/persona-kit';

// from @agentworkforce/runtime (core)
import { handler, type WorkforceCtx, type WorkforceEvent, type IntegrationClients } from '@agentworkforce/runtime';
import { buildCtx, type CtxBuildOptions } from '@agentworkforce/runtime/internal'; // internal subpath
```

If any of these aren't exported yet when you reach for them, leave the `TODO(human)` comment described above and move on.

---

## Task 1 — Per-integration clients (HIGHEST PRIORITY)

**Goal:** Concrete TS clients for each Relayfile provider, exposed on `WorkforceCtx` as `ctx.github`, `ctx.linear`, etc.

**Files to create:**
- `packages/runtime/src/clients/github.ts`
- `packages/runtime/src/clients/linear.ts`
- `packages/runtime/src/clients/slack.ts`
- `packages/runtime/src/clients/notion.ts`
- `packages/runtime/src/clients/jira.ts`
- `packages/runtime/src/clients/index.ts` (barrel)
- `packages/runtime/src/clients/<provider>.test.ts` for each

**Per-client contract:**

```ts
export interface GithubClient {
  comment(target: { owner: string; repo: string; number: number }, body: string): Promise<{ id: string; url: string }>;
  createIssue(args: { owner: string; repo: string; title: string; body: string; labels?: string[] }): Promise<{ number: number; url: string }>;
  upsertIssue(args: { owner: string; repo: string; title: string; body: string; labels?: string[]; matchTitle: string }): Promise<{ number: number; url: string; created: boolean }>;
  getPr(target: { owner: string; repo: string; number: number }): Promise<{ title: string; body: string; diff: string; head: string; base: string; author: string }>;
  postReview(target: { owner: string; repo: string; number: number }, args: { body: string; event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'; comments?: Array<{ path: string; line: number; body: string }> }): Promise<void>;
}

export function createGithubClient(opts: {
  connectionId: string;   // from Relayfile
  relayfileBaseUrl: string;
}): GithubClient;
```

Mirror this shape for the other providers. Method coverage per provider:

| Provider | Methods (v1) |
|---|---|
| `github` | as above |
| `linear` | `createIssue`, `updateIssue`, `comment`, `getIssue` |
| `slack` | `post(channel, text)`, `reply(threadTs, text)`, `dm(user, text)` |
| `notion` | `createPage(parent, properties, content)`, `updatePage`, `getPage` |
| `jira` | `createIssue`, `comment`, `transition` |

**Implementation pattern:**
- Auth: each call sends `Authorization: Bearer <relayfile-issued-scoped-token>`; the connection-id resolves to a token at request time via Relayfile's `/api/v1/connections/:id/token` (check `@relayfile/sdk` for the exact helper — `RelayfileSetup` likely has one).
- Errors: throw `WorkforceIntegrationError` (define in `packages/runtime/src/errors.ts`) with `provider`, `operation`, `cause`, `retryable` fields.
- Don't implement retries here — the runtime's outer loop handles it. Just throw with `retryable: true` for 5xx and 429s.
- No SDK heavy lifting — use `fetch`. Each client should be <150 lines.

**Acceptance:**
- All five client files compile and pass their tests.
- `WorkforceCtx`'s per-integration fields are populated by `ctx.ts` when the persona declares that integration. (The human owns `ctx.ts`; you just expose `createXxxClient` so it can call them.)

**Effort:** ~2–3h total across all five (~30min each).

---

## Task 2 — Bundle stager (`bundle.ts`)

**Goal:** Pure file-staging function the deploy orchestrator calls to produce a runnable bundle in `.workforce/build/<persona-id>/`.

**File to create:** `packages/deploy/src/bundle.ts` (+ test)

**Contract:**

```ts
export interface BundleInput {
  personaPath: string;          // absolute path to the persona JSON
  persona: PersonaSpec;         // already-parsed
  outDir: string;               // .workforce/build/<persona-id>
  bundlerOptions?: { minify?: boolean };
}

export interface BundleResult {
  personaCopyPath: string;      // outDir/persona.json
  runnerPath: string;           // outDir/runner.mjs (entry)
  bundlePath: string;           // outDir/agent.bundle.mjs (esbuild'd agent.ts)
  packageJsonPath: string;
  sizeBytes: number;
}

export async function stageBundle(input: BundleInput): Promise<BundleResult>;
```

**What it does:**
1. Resolve `persona.onEvent` relative to `personaPath`. Verify file exists.
2. Esbuild the `onEvent` file as ESM bundle → `outDir/agent.bundle.mjs`. Bundle target `node20`, format `esm`, platform `node`, sourcemap `inline`, external all `node:*` plus `@agentworkforce/runtime/raw`.
3. Copy `persona.json` (the parsed object stringified) to `outDir/persona.json`.
4. Generate `outDir/runner.mjs` from this exact template:
   ```js
   import { startRunner } from '@agentworkforce/runtime/runner';
   import persona from './persona.json' assert { type: 'json' };
   import * as agentModule from './agent.bundle.mjs';
   const handler = agentModule.default ?? agentModule.handler;
   startRunner({ persona, handler });
   ```
5. Write `outDir/package.json` listing `@agentworkforce/runtime` at the workspace version.
6. Return `BundleResult` with byte size.

**Dependencies allowed:** `esbuild`, `node:fs/promises`, `node:path`. Nothing else.

**Acceptance:**
- Given `examples/weekly-digest/persona.json`, `stageBundle` produces a working bundle whose `runner.mjs` runs under `node runner.mjs` (assuming `@agentworkforce/runtime/runner` exists — if not, leave the runner template and TODO).
- Idempotent: running twice cleans and rewrites.
- Tested with a fixture persona under `packages/deploy/src/__fixtures__/`.

**Effort:** ~1h.

---

## Task 3 — `modes/dev.ts` — local long-lived runner

**Goal:** Spawn the bundled runner as a child Node process, stream logs to stdout, hold the parent process open until SIGINT.

**File to create:** `packages/deploy/src/modes/dev.ts` (+ test)

**Contract:**

```ts
export interface DevRunInput {
  bundle: BundleResult;
  env?: Record<string, string>;
  onLog?: (line: string) => void;
}

export interface DevRunHandle {
  pid: number;
  stop(): Promise<void>;
  done: Promise<{ code: number; signal: NodeJS.Signals | null }>;
}

export async function runDev(input: DevRunInput): Promise<DevRunHandle>;
```

**Implementation:**
- Use `node:child_process.spawn('node', [bundle.runnerPath], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...input.env } })`.
- Line-buffer stdout/stderr (avoid partial lines). Prefix each line with `[runtime]` before forwarding to `onLog` or `console.log` default.
- `stop()` sends SIGTERM, escalates to SIGKILL after 5s.
- Forward SIGINT on the parent: kill the child cleanly.
- `done` resolves on child exit.

**Acceptance:** A unit test using a stub `runner.mjs` that prints "hello" and exits — verifies the log line is captured and `done` resolves with `code: 0`.

**Effort:** ~45min.

---

## Task 4 — `modes/sandbox.ts` — Daytona launcher

**Goal:** Same shape as `runDev`, but launches inside a Daytona sandbox.

**File to create:** `packages/deploy/src/modes/sandbox.ts` (+ test using a Daytona mock)

**Contract:**

```ts
export interface SandboxRunInput {
  bundle: BundleResult;
  sandboxConfig: SandboxConfig | true;
  env?: Record<string, string>;
  onLog?: (line: string) => void;
  daytona: { apiKey: string; jwtToken?: string; organizationId?: string };
}

export interface SandboxRunHandle {
  sandboxId: string;
  stop(): Promise<void>;
  done: Promise<{ code: number }>;
}

export async function runSandbox(input: SandboxRunInput): Promise<SandboxRunHandle>;
```

**Implementation:**
- `import { Daytona } from '@daytonaio/sdk'` (already used in `cloud/packages/core/src/runtime/daytona.ts` — same SDK).
- `new Daytona({ apiKey })`; `daytona.create({ language: 'typescript', envVars: input.env })`.
- `sandbox.fs.uploadFiles([...])` — upload the entire bundle directory recursively.
- `sandbox.process.executeCommand('node runner.mjs', '/home/user/project', input.env, input.sandboxConfig?.timeoutSeconds ?? 1800)`.
- Stream output. Daytona's `executeCommand` is final-result-only; for log streaming use `sandbox.process.createSession()` + `executeSessionCommand` with the streaming variant if available. If not (check SDK version), fall back to polling `executeCommand` output every 2s. Note the gap in the PR body.
- `stop()` calls `sandbox.delete()`.

**Acceptance:** Test with a mocked `@daytonaio/sdk` that simulates create + exec + delete; assert call sequence.

**Effort:** ~1.5h (Daytona SDK surface verification is most of the time).

---

## Task 5 — Examples

### 5a. `examples/weekly-digest/`

**Files:** `examples/weekly-digest/persona.json`, `examples/weekly-digest/agent.ts`, `examples/weekly-digest/README.md`.

**persona.json:** Use the shape from `deploy-v1.md` §7.1. `id: "weekly-digest"`. Schedule `0 9 * * 6`. GitHub integration only. Memory enabled with `workspace` scope. No sandbox config (defaults on).

**agent.ts:** Default-export a `handler(...)`. On `event.source === 'cron'`:
1. Fetch search results from Brave Search API (env: `BRAVE_API_KEY`) for the topics in `persona.inputs.TOPICS` (define this input with a default list of 3 topics).
2. Dedupe + cluster by URL host.
3. Upsert one GitHub issue per week titled `Weekly digest — <ISO week>`, body listing clustered findings. Use `ctx.github.upsertIssue` with `matchTitle`.
4. Save a memory note: "digest published for week N" with `tags: ['digest', 'week:<N>']`.

Aim for ~80 lines. Keep it readable.

### 5b. `examples/review-agent/`

**Files:** `examples/review-agent/persona.json`, `examples/review-agent/agent.ts`, `examples/review-agent/README.md`.

**persona.json:** From §7.2 of the plan. GitHub + Slack integrations. `useSubscription: true`. Memory enabled. Traits set.

**agent.ts:** Dispatches on `event.source` + `event.type`:
- `github.pull_request.opened` → `ctx.harness.run({ prompt: \`Review this PR:\n${diff}\`, cwd: ctx.sandbox.cwd })` → `ctx.github.postReview(target, { event: 'COMMENT', body: result.output })`.
- `github.issue_comment.created` (matched as `@mention`) → reply with `ctx.github.comment` using harness output with thread context.
- `github.pull_request_review_comment.created` → similar reply.
- `github.check_run.completed` w/ failure → harness with the failed CI logs, post a comment with the proposed fix.
- `slack.app_mention` → conversational reply via memory + harness. Use `ctx.slack.reply`.

Aim for ~120 lines.

**Acceptance:**
- Both `agent.ts` files typecheck against `@agentworkforce/runtime`.
- Both `persona.json` parse via `parsePersonaSpec` without errors.
- Both READMEs document setup (which integrations to connect first, which env vars to set).

**Effort:** ~1h for both.

---

## Task 6 — Trigger registry expansion

**File:** `packages/persona-kit/src/triggers.ts` (the human creates a stub; you fill it in).

**Source of truth:** `/Users/khaliqgant/Projects/AgentWorkforce/relayfile/docs/` and the Relayfile adapter packages under `/Users/khaliqgant/Projects/AgentWorkforce/relayfile-adapters/`.

For each Tier-1 provider (`github`, `linear`, `slack`, `notion`, `jira`), enumerate every event name the adapter normalizes. Output:

```ts
export const KNOWN_TRIGGERS = {
  github: ['pull_request.opened', 'pull_request.closed', /* ... */] as const,
  linear: ['issue.created', /* ... */] as const,
  // ...
} as const satisfies Record<string, readonly string[]>;

export type ProviderName = keyof typeof KNOWN_TRIGGERS;
export type TriggerOf<P extends ProviderName> = (typeof KNOWN_TRIGGERS)[P][number];
```

Also expose a `lintTriggers(persona: PersonaSpec): TriggerLintIssue[]` function that returns warnings for unknown trigger names (don't throw).

**Acceptance:** Each provider has ≥8 trigger names. `lintTriggers` returns `[]` for the two examples shipped in Task 5.

**Effort:** ~45min.

---

## Task 7 — JSON Schema export + persona fixtures

**Files:**
- `packages/persona-kit/scripts/emit-schema.mjs` — emits JSON Schema for the extended `PersonaSpec` (use `ts-json-schema-generator` or `typescript-json-schema`; pick whichever has fewer transitive deps).
- `packages/persona-kit/schemas/persona.schema.json` — generated artifact, checked in.
- `packages/persona-kit/src/__fixtures__/personas/minimal.json` — bare persona (no cloud fields).
- `packages/persona-kit/src/__fixtures__/personas/cron-only.json` — cloud + schedules, no integrations.
- `packages/persona-kit/src/__fixtures__/personas/full.json` — every optional field populated.
- `packages/persona-kit/src/__fixtures__/personas/invalid-unknown-trigger.json` — should produce a lint warning.
- `packages/persona-kit/scripts/emit-schema.test.ts` — round-trips each fixture through the schema.

Wire `emit-schema.mjs` to run as part of `pnpm run build` (or `prebuild`).

**Acceptance:** Each fixture validates against the emitted schema. The script is idempotent.

**Effort:** ~1h.

---

## Task 8 — `examples/linear-shipper/` (paraglide pattern)

**Files:** `examples/linear-shipper/persona.json`, `examples/linear-shipper/agent.ts`, `examples/linear-shipper/README.md`.

**persona.json:** Headless (no traits). `cloud: true`. Linear + GitHub integrations. Trigger: `linear.issue.created`. Sandbox on.

**agent.ts:** On `linear.issue.created`:
1. Pull issue body via `ctx.linear.getIssue`.
2. Clone the target repo into `ctx.sandbox.cwd` via `ctx.sandbox.exec('git clone ...')`.
3. `ctx.harness.run({ prompt: \`Implement this Linear issue:\n${issue.body}\`, cwd: ctx.sandbox.cwd })`.
4. Open a draft PR via `ctx.github.createIssue` (or `createPr` if exposed — add to GithubClient if needed and update Task 1's contract via a TODO comment).
5. Comment back on the Linear issue with the PR link via `ctx.linear.comment`.

Aim for ~100 lines.

**Acceptance:** persona.json parses; agent.ts typechecks.

**Effort:** ~45min.

---

## Task 9 — README rewrite

**File:** `README.md` at the workforce repo root.

Lead with the deploy story: "A persona is a deployable agent." Show `workforce deploy ./review-agent.json` as the headline example. Demote the existing local-CLI usage section to "Local agents" further down.

Sections:
1. Quick start: `workforce deploy ./examples/weekly-digest/persona.json`
2. What a persona looks like (short JSON snippet)
3. Run modes (`--dev`, `--sandbox`, `--cloud`)
4. Integrations supported
5. Local agents (existing content)
6. Personas as packages (existing content)

Keep marketing language minimal. Match the existing voice.

**Acceptance:** Renders cleanly on GitHub. Links to the examples and to `docs/plans/deploy-v1.md`.

**Effort:** ~30min.

---

## Suggested execution order

If you have one agent: 1 → 6 → 7 → 2 → 3 → 4 → 5 → 8 → 9.

If you parallelize across multiple codex agents:
- Track A (independent): Task 1 (github + linear first, then slack/notion/jira).
- Track B (independent): Task 6, Task 7.
- Track C (depends on A's github+linear): Task 5, Task 8.
- Track D (depends on bundle.ts contract being agreed — read it from this spec): Task 2, Task 3, Task 4 sequentially.
- Track E (last): Task 9, after Tasks 1–5 are merged.

Each track is its own PR series. No track waits on another's review.

## When you are blocked

- **Missing exported symbol from `@agentworkforce/runtime`?** Leave `TODO(human): need <thing>` in code + flag in PR body. Don't speculate.
- **Disagreement with the plan?** Open a comment thread on the PR for `deploy-v1.md` — don't unilaterally change the contract.
- **Test failing for a reason you can't isolate?** Skip it with `it.skip(..., 'TODO(human): <why>')` and ship the rest of the task. Don't block a track on a flake.

## Out of scope for you (the human owns these)

- Schema types in `packages/persona-kit/src/types.ts` and the parser in `parse.ts`.
- `@agentworkforce/runtime` core: `handler()`, `WorkforceCtx`, `WorkforceEvent`, ctx builder, the `@agent-relay/agent` shim.
- `@agentworkforce/deploy` orchestrator entry (`index.ts`).
- CLI dispatch case in `packages/cli/src/cli.ts`.
- `workforce login` helper.
- This plan and spec files.
