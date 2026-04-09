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

```ts
import { resolvePersona, materializeSkillsFor } from '@agentworkforce/workload-router';

const selection = resolvePersona('npm-provenance');
// selection -> { personaId, tier, runtime, skills, rationale }
// selection.runtime.harness -> opencode | codex | claude
// selection.runtime.model   -> concrete model
// selection.skills          -> [{ id, source, description }, ...]

// Turn the persona's declared skills into a harness-correct install plan.
const plan = materializeSkillsFor(selection);
for (const install of plan.installs) {
  // e.g. ['npx', '-y', 'prpm', 'install', 'prpm/npm-trusted-publishing', '--as', 'codex']
  spawnSync(install.installCommand[0], install.installCommand.slice(1), { stdio: 'inherit' });
}
```

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
2. Resolve profile policy + persona runtime via `resolvePersona(intent)`.
3. Spawn subagent with returned harness/model/settings/prompt.

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
