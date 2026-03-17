# workforce

Shared AgentWorkforce primitives for persona-driven orchestration.

## Core frame

A **persona** is the runtime source of truth:

- prompt (`systemPrompt`)
- model
- harness
- harness settings

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

## Routing profiles

- `packages/workload-router/routing-profiles/default.json`
- `packages/workload-router/routing-profiles/schema.json`

## TypeScript SDK usage

```ts
import { resolvePersona } from '@agentworkforce/workload-router';

const selection = resolvePersona('review');
// selection -> { personaId, tier, runtime, rationale }
// selection.runtime.harness -> opencode|codex
// selection.runtime.model -> concrete model
```

## OpenClaw integration pattern

1. Map user request to `intent`:
   - `implement-frontend`
   - `review`
   - `architecture-plan`
2. Resolve profile policy + persona runtime via `resolvePersona(intent)`.
3. Spawn subagent with returned harness/model/settings/prompt.

See runnable mapping example:
- `examples/openclaw-routing.ts`

This keeps runtime configuration in personas, while routing policy stays explicit, typed, and auditable.

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
