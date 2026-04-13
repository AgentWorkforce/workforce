# workforce

Shared AgentWorkforce primitives for persona-driven orchestration.

## Core frame

A **persona** is the runtime source of truth:

- prompt (`systemPrompt`)
- model
- harness
- harness settings
- optional `skills` array of `{ id, source, description }` entries for reusable capability guidance (e.g. prpm.dev packages)

Each persona supports service tiers:

- `best`
- `best-value`
- `minimum`

Tiering controls depth, latency budget, and model cost envelope — **not** the quality bar.
All tiers should enforce the same correctness/safety standards; lower tiers should be more concise, not lower-quality.

A **routing profile** is policy-only. It does not carry runtime fields; it only selects which persona tier to use per intent and explains why.

## Packages

- `packages/workload-router` — TypeScript SDK for typed persona + routing profile resolution.

## Personas

- `personas/frontend-implementer.json`
- `personas/code-reviewer.json`
- `personas/architecture-planner.json`
- `personas/requirements-analyst.json`
- `personas/debugger.json`
- `personas/security-reviewer.json`
- `personas/technical-writer.json`
- `personas/verifier.json`
- `personas/test-strategist.json`
- `personas/tdd-guard.json`
- `personas/flake-hunter.json`
- `personas/opencode-workflow-specialist.json`
- `personas/npm-provenance-publisher.json`

## Routing profiles

- `packages/workload-router/routing-profiles/default.json`
- `packages/workload-router/routing-profiles/schema.json`

## TypeScript SDK usage

The recommended entry point is **`usePersona(intent)`** — a synchronous,
side-effect-free factory that resolves a persona and returns an `execute()`
closure. Calling it does nothing but pre-compute the routing; nothing is
installed or spawned until you call `execute()`.

```ts
import { usePersona } from '@agentworkforce/workload-router';

const { execute } = usePersona('npm-provenance');

// Installs the persona's skills, then runs the persona's harness agent
// with your task. Returns a PersonaExecution — awaitable, with
// `cancel()` and a `runId` promise attached.
const result = await execute('Set up npm trusted publishing for this repo', {
  workingDirectory: '.',
  timeoutSeconds: 600,
});

if (result.status !== 'completed') {
  console.error('persona run failed', result.status, result.stderr);
}
```

> Despite the `use*` prefix, **`usePersona` is not a React hook.** It is a
> plain synchronous factory with no implicit state — safe to call anywhere.

For the full API — the install-only mode, pre-staged install with
`installSkills: false`, cancellation via `AbortSignal`, streaming progress,
the `runId` timing contract, and the double-install caveat when mixing
modes — see **[`packages/workload-router/README.md`](./packages/workload-router/README.md)**.

<details>
<summary>Low-level primitives (advanced use — prefer <code>usePersona</code> for new code)</summary>

If you need to resolve a persona and materialize its skill install plan
**without** running an agent — or you want to drive install yourself with
custom process management — `usePersona` is built on top of two pure
helpers you can call directly:

```ts
import { resolvePersona, materializeSkillsFor } from '@agentworkforce/workload-router';
import { spawnSync } from 'node:child_process';

const selection = resolvePersona('npm-provenance');
// selection -> { personaId, tier, runtime, skills, rationale }

const plan = materializeSkillsFor(selection);
for (const install of plan.installs) {
  // install.installCommand is an argv array (safer for execFile/spawn).
  // For a shell string, use `usePersona(...).installCommandString`.
  spawnSync(install.installCommand[0], install.installCommand.slice(1), { stdio: 'inherit' });
}
```

These primitives are exported for callers who need direct access to the
plan object or want to skip the `execute()` workflow entirely. New code
should prefer `usePersona` — it consolidates routing, install planning,
and agent execution into one call and gives you cancellation / progress /
run-id observability for free.

</details>

## OpenClaw integration pattern

1. Map user request to `intent`:
   - `implement-frontend`
   - `review`
   - `architecture-plan`
   - `requirements-analysis`
   - `debugging`
   - `security-review`
   - `documentation`
   - `verification`
   - `test-strategy`
   - `tdd-enforcement`
   - `flake-investigation`
   - `opencode-workflow-correctness`
   - `npm-provenance`
2. Call `usePersona(intent, { profile? })` to resolve the persona and
   receive an `execute()` closure bound to its runtime (harness, model,
   settings, prompt) and skill install plan.
3. Call `execute(task, opts)` to install the persona's skills and invoke
   its harness agent in one step. Use `AbortSignal` / `execution.cancel()`
   for cancellation and `onProgress` to stream stdout/stderr.

If you need to bypass `execute()` and spawn the agent yourself — for
example, to integrate with an existing orchestrator — `resolvePersona` +
`materializeSkillsFor` remain available as the underlying primitives
(see the collapsed section above).

See runnable mapping example:
- `examples/openclaw-routing.ts`

This keeps runtime configuration in personas, while routing policy stays explicit, typed, and auditable.

## Skills on personas

A persona can declare a `skills` array of reusable capability packages (e.g. from [prpm.dev](https://prpm.dev)):

```json
"skills": [
  {
    "id": "prpm/npm-trusted-publishing",
    "source": "https://prpm.dev/packages/prpm/npm-trusted-publishing",
    "description": "OIDC-based npm publish without long-lived tokens"
  }
]
```

Persona JSON is harness-agnostic — it declares *what* skill is needed, not *how* to install it. The SDK's `materializeSkills(skills, harness)` / `materializeSkillsFor(selection)` helper turns the declaration into a concrete install plan, routing each skill to the right on-disk convention per harness:

| Harness    | Install flag       | Skill directory    |
| ---------- | ------------------ | ------------------ |
| `claude`   | `prpm install --as claude`   | `.claude/skills/` |
| `codex`    | `prpm install --as codex`    | `.agents/skills/` |
| `opencode` | `prpm install --as opencode` | `.agents/skills/` |

Each returned `SkillInstall` carries an argv-style `installCommand`, `installedDir`, and `installedManifest` path. The helper is pure — it never shells out or touches disk — so callers (relay workflows, OpenClaw spawners, ad-hoc scripts) decide how to execute it. Once installed, Claude Code auto-discovers skills from `.claude/skills/`; for other harnesses, read the manifest off disk and inject it into the agent's task body.

## Eval framework (scaffold direction)

Next step is a benchmark harness to score persona/tier combinations on:

- quality (task pass rate)
- cost
- latency

Then publish a versioned “recommended tier map” so default routing is data-backed.

## Quick start

```bash
corepack enable
pnpm install
pnpm run check
```

This runs minimal guardrails across the workspace:

- `lint` (currently TypeScript-only)
- `typecheck` (package + examples)
- `test` (Node test runner)
