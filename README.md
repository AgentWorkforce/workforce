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

## Using this with OpenClaw (Barry setup)

This repo is designed to be consumed by an orchestration layer (like OpenClaw) before spawning coding subagents.

### 1) Classify the incoming job
Map each request to a `taskType` and `risk` (for example: `lint` + `low`, or `architecture` + `high`).

### 2) Route to a lane
Use `routeWorkload(taskType, risk)` from `@agentworkforce/workload-router` to select:
- lane id
- harness (`opencode` or `codex`)
- primary/fallback model family

### 3) Spawn with lane-specific runtime
In OpenClaw, use the selected lane to drive subagent runtime decisions:
- **qa-cheap** → OpenCode + cheap/free models
- **impl-mid** → OpenCode + low-cost implementation model
- **architecture-high** → Codex high-reasoning model
- **review-audit** → Codex reviewer lane

### 4) Enforce policy gates
Before running:
- block risky tasks in cheap lanes
- escalate ambiguous/high-risk tasks
- require rationale on routing decision

### 5) Optional reviewer pass
Run `personas/workforce-reviewer.json` as a second-pass checker for high-risk tasks/PRs.

### Example flow (OpenClaw)

1. User asks for a task (eg. "fix flaky test in module X").
2. OpenClaw classifies: `taskType=test-triage`, `risk=low`.
3. Router returns `qa-cheap` lane.
4. OpenClaw spawns a subagent with OpenCode and low-cost model profile.
5. For sensitive changes, OpenClaw triggers reviewer persona before merge.

This gives you consistent cost control without sacrificing safety on high-impact changes.
