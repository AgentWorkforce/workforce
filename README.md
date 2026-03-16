# workforce

Shared AgentWorkforce primitives for agent orchestration.

## Initial scope

- Workload routing (job -> lane -> harness/model)
- Policy gates (risk/cost/escalation)
- Reusable lane profiles for coding workflows

## Packages

- `packages/workload-router` — route tasks to lanes based on type/risk/cost.

## Quick start

```bash
pnpm install
pnpm -r test
```
