# workforce

Shared AgentWorkforce primitives for agent orchestration.

## Initial scope

- Workload routing (job -> lane -> harness/model)
- Policy gates (risk/cost/escalation)
- Reusable lane profiles for coding workflows
- Agent metadata + system prompts for orchestration roles

## Packages

- `packages/workload-router` — TypeScript router for lane selection based on task/risk.

## Agent personas

- `personas/workforce-router.json` — router metadata + system prompt for routing responsibilities.
- `personas/workforce-reviewer.json` — reviewer metadata + system prompt for auditing routing decisions.

## Quick start

```bash
pnpm install
pnpm -r build
pnpm -r test
```
