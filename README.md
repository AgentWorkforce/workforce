# workforce

Shared AgentWorkforce primitives for agent orchestration.

## Initial scope

- Workload routing (job -> lane -> harness/model)
- Policy gates (risk/cost/escalation)
- Reusable lane profiles for coding workflows
- Agent metadata + system prompts for orchestration roles

## Packages

- `packages/workload-router` — TypeScript router for lane selection based on task/risk.

## Agent profiles

- `agents/workforce-router.toml` — starter metadata + system prompt for routing responsibilities.

## Quick start

```bash
pnpm install
pnpm -r build
pnpm -r test
```
