# workforce

Shared AgentWorkforce primitives for persona-driven orchestration.

## Core frame

A **persona** is the unit of execution selection:

- prompt (`systemPrompt`)
- model
- harness
- harness settings

Each persona supports quality/cost tiers:

- `best`
- `best-value`
- `minimum`

## Packages

- `packages/workload-router` — TypeScript SDK for typed persona resolution.

## Personas

- `personas/frontend-implementer.json`
- `personas/code-reviewer.json`
- `personas/architecture-planner.json`

## TypeScript SDK usage

```ts
import { resolvePersona } from '@agentworkforce/workload-router';

const selection = resolvePersona('review', 'best-value');
// selection.runtime.harness -> opencode|codex
// selection.runtime.model -> concrete model
// selection.runtime.systemPrompt -> persona prompt
```

## OpenClaw integration pattern

1. Map user request to `intent`:
   - `implement-frontend`
   - `review`
   - `architecture-plan`
2. Choose tier (`best`, `best-value`, `minimum`) based on budget/risk.
3. Call `resolvePersona(intent, tier)`.
4. Spawn subagent with returned harness/model/settings/prompt.

This keeps routing typed, auditable, and reusable across Relay workflows.

## Eval framework (scaffold direction)

Next step is a benchmark harness to score persona/tier combinations on:

- quality (task pass rate)
- cost
- latency

Then publish a versioned “recommended tier map” so default routing is data-backed.

## Quick start

```bash
pnpm install
pnpm -r build
pnpm -r test
```
