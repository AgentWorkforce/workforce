
# choosing-swarm-patterns
reason=Spec text mentions "agents". Spec text mentions "agent". Spec text mentions "relay". Spec text mentions "covers". Spec text mentions "core". Spec text mentions "decision".
---
name: choosing-swarm-patterns
description: Use when coordinating multiple AI agents with Agent Relay's workflow engine and need to pick the right orchestration pattern - covers the 10 core patterns (fan-out, pipeline, hub-spoke, consensus, mesh, handoff, cascade, dag, debate, hierarchical) plus 14 specialized ones, with decision framework and accurate SDK/YAML examples.
---

### Overview

The Agent Relay SDK (`@agent-relay/sdk`) supports 24 swarm patterns via a single `swarm.pattern` field. Patterns are configured declaratively in YAML or programmatically via the `workflow()` fluent builder — there are no standalone `fanOut(...)` / `hubAndSpoke(...)` helpers. Pick the simplest pattern that solves the problem; add complexity only when the system proves it's insufficient.

### Two ways to run a pattern

#### **1. YAML (portable):**

```ts
import { runWorkflow } from "@agent-relay/sdk/workflows";

const run = await runWorkflow("workflows/feature-dev.yaml", {
  vars: { task: "Add OAuth login" },
});
```


### Quick Decision Framework

#### ```

```
Is the task independent per agent?
  YES → fan-out (parallel workers, hub collects)

Does each step need the previous step's output?
  YES → Is it strictly linear?
    YES → pipeline
    NO  → dag (parallel where possible, `dependsOn` edges)

Does a coordinator need to stay alive and adapt?
  YES → hub-spoke (single-level hub + workers)
        hierarchical (structurally identical in current impl; use for naming/intent)

Is the task about making a decision?
  YES → Do agents need to argue opposing sides?
    YES → debate (adversarial, full mesh)
    NO  → consensus (cooperative, full mesh + coordination.consensusStrategy)

Does the right specialist emerge during processing?
  YES → handoff (sequential chain, one active at a time)

Do all agents need to freely collaborate?
  YES → mesh (full peer-to-peer edges)

Is cost the primary concern?
  YES → cascade (chain of increasingly capable agents; each step's prompt
        decides whether to pass through or redo the prior output)
```


### Pattern Reference (Core 10)

| # | Pattern | Topology (actual edges) | Best For |
|---|---------|------------------------|----------|
| 1 | **fan-out** | Hub broadcasts to N workers; workers reply to hub only | Independent subtasks (reviews, research, tests) |
| 2 | **pipeline** | Linear chain (agent_i → agent_{i+1}) | Ordered stages (design → implement → test) |
| 3 | **hub-spoke** | Hub ↔ spokes (bidirectional); no spoke-to-spoke | Dynamic coordination, lead reviews/adjusts |
| 4 | **consensus** | Full mesh; decision via `coordination.consensusStrategy` | Architecture decisions, approval gates |
| 5 | **mesh** | Full mesh (every agent ↔ every other) | Brainstorming, collaborative debugging |
| 6 | **handoff** | Chain; passes control forward | Triage, specialist routing |
| 7 | **cascade** | Chain of `dependsOn` steps; all run on success, downstream skipped on upstream failure (no built-in "fall through") | Cost optimization: cheap first, each step's prompt passes through or redoes |
| 8 | **dag** | Edges from step `dependsOn` | Mixed dependencies, parallel where possible |
| 9 | **debate** | Full mesh (same topology as mesh; roles drive behavior) | Rigorous adversarial examination |
| 10 | **hierarchical** | Hub + subordinates (single-level in current impl) | Large teams; semantic distinction from hub-spoke |

> **Heads up:** `hierarchical` resolves to the same edge structure as `hub-spoke` in `coordinator.ts:313-319`. Multi-level tree topology is not currently implemented — use pattern name for intent, but expect the same runtime graph.

### Additional Patterns (role-driven)

These 14 additional patterns exist in `SwarmPattern` (types.ts:114-139). The coordinator has role-based auto-selection heuristics (`coordinator.ts:51-165`), but they only fire when `swarm.pattern` is **omitted** — YAML validation requires it (`runner.ts:2105-2117`), so auto-selection is effectively a programmatic-API feature. In YAML, set `swarm.pattern` explicitly.

Topology is still resolved per-pattern once selected; the "Triggering roles" column reflects what the coordinator looks for to shape edges (per `coordinator.ts:250-450`):

| Pattern | Roles the topology keys off | Topology |
|---------|-----------------------------|----------|
| `map-reduce` | `mapper` + `reducer` | coordinator → mappers → reducers → coordinator |
| `scatter-gather` | — | hub → workers → hub |
| `supervisor` | `supervisor` | supervisor ↔ workers |
| `reflection` | `critic` or `reviewer` (auto-select uses `critic` only) | producers → critic → producers (loop) |
| `red-team` | `attacker`/`red-team` + `defender`/`blue-team` | adversarial mesh with optional judges |
| `verifier` | `verifier` | producers → verifiers → back to producers |
| `auction` | `auctioneer` | auctioneer → bidders → auctioneer |
| `escalation` | `tier-*` | tiered chain, escalate up / report down |
| `saga` | `saga-orchestrator`, `compensate-handler` | orchestrator ↔ participants |
| `circuit-breaker` | `primary` + `fallback`/`backup` | try primary, fallback on failure |
| `blackboard` | `blackboard` / `shared-workspace` | shared state hub |
| `swarm` | `hive-mind` / `swarm-agent` | stigmergy-style |
| `competitive` | — (declared explicitly) | independent parallel implementations + judge |
| `review-loop` | `implement*` + 2+ `reviewer*` | implementer ↔ reviewers |

### Structured Squad Review Loop

- Split the work into bounded implementation squads. Each squad owns a non-overlapping file or subsystem scope.
- Give each squad an implementer plus a shadow/review partner. The shadow follows the implementer in real time, checks alignment with the spec, and posts concise feedback before the work drifts.
- Require the implementer to self-reflect before external review: compare the final diff against the spec, AGENTS.md / CLAUDE.md, recent local conventions, tests, and declared non-goals.
- Run an independent self-review/fresh-eyes agent that reads the actual files and recent repo context, not just the chat transcript.
- Send that review back to the implementer for one repair round.
- After squads converge, run a final two-agent review team, usually one Claude reviewer and one Codex reviewer, independently. They compare notes, merge findings, and produce one final verdict.
- Spawn fresh fix agents for final-review findings. Those fix agents self-reflect, then the final reviewers re-check the post-fix state until the spec is fully satisfied or a blocker is documented.
- Use `supervisor` or `hub-spoke` when a lead needs to coordinate live squads.
- Use `review-loop` when the main risk is code quality and feedback iteration.
- Use `reflection` when critic feedback should loop directly back to producers.
- Use `verifier` when completion evidence matters more than design debate.
- Use `competitive` only when independent alternative implementations are useful; otherwise split by ownership scope.

### Pattern Details

#### 1. fan-out — Parallel Workers

```ts
await workflow("review")
  .pattern("fan-out")
  .agent("lead",     { cli: "claude", role: "lead" })
  .agent("auth-rev", { cli: "claude", role: "worker", interactive: false })
  .agent("db-rev",   { cli: "claude", role: "worker", interactive: false })
  .step("review-auth", { agent: "auth-rev", task: "Review auth.ts" })
  .step("review-db",   { agent: "db-rev",   task: "Review db.ts" })
  .run();
```

#### 2. pipeline — Sequential Stages

```yaml
swarm: { pattern: pipeline }
agents:
  - { name: designer,    cli: claude }
  - { name: implementer, cli: codex, interactive: false }
  - { name: tester,      cli: codex, interactive: false }
workflows:
  - name: build
    steps:
      - { name: design,    agent: designer,    task: "Design the API schema",
          verification: { type: output_contains, value: DONE } }
      - { name: implement, agent: implementer, dependsOn: [design],
          task: "Implement: {{steps.design.output}}" }
      - { name: test,      agent: tester,      dependsOn: [implement],
          task: "Write integration tests" }
```

#### 3. hub-spoke — Persistent Coordinator

```ts
await workflow("api-build")
  .pattern("hub-spoke")
  .channel("swarm-api")
  .agent("lead",       { cli: "claude", role: "lead" })
  .agent("db-worker",  { cli: "claude", role: "worker" })   // interactive by default — hub DMs it
  .agent("api-worker", { cli: "claude", role: "worker" })   // interactive by default — hub DMs it
  .step("models",  { agent: "db-worker",  task: "Build database models" })
  .step("routes",  { agent: "api-worker", task: "Build route handlers", dependsOn: ["models"] })
  .step("review",  { agent: "lead",       task: "Review everything",    dependsOn: ["routes"] })
  .run();
```

#### 4. consensus — Cooperative Voting

```yaml
swarm: { pattern: consensus }
agents:
  - { name: perf,  cli: claude, role: reviewer }
  - { name: dx,    cli: claude, role: reviewer }
  - { name: sec,   cli: claude, role: reviewer }
coordination:
  consensusStrategy: majority   # declarative marker: majority | unanimous | quorum
  votingThreshold: 0.66
workflows:
  - name: decide
    steps:
      - { name: evaluate-perf, agent: perf, task: "Evaluate perf of Fastify migration" }
      - { name: evaluate-dx,   agent: dx,   task: "Evaluate DX of Fastify migration" }
      - { name: evaluate-sec,  agent: sec,  task: "Evaluate security of Fastify migration" }
```

#### 5. mesh — Peer Collaboration

```ts
await workflow("debug-auth")
  .pattern("mesh")
  .channel("swarm-debug")
  .agent("logs",     { cli: "claude" })
  .agent("code",     { cli: "claude" })
  .agent("repro",    { cli: "claude" })
  .step("logs",  { agent: "logs",  task: "Check server logs" })
  .step("code",  { agent: "code",  task: "Review auth code" })
  .step("repro", { agent: "repro", task: "Write repro test" })
  .run();
```

#### 6. handoff — Dynamic Routing

```yaml
swarm: { pattern: handoff }
agents:
  - { name: triage,   cli: claude }
  - { name: billing,  cli: claude }
  - { name: tech,     cli: claude }
workflows:
  - name: support
    steps:
      - { name: triage,  agent: triage,  task: "Triage: {{request}}" }
      - { name: billing, agent: billing, dependsOn: [triage], task: "Handle billing" }
      - { name: tech,    agent: tech,    dependsOn: [triage], task: "Handle tech issues" }
```

#### 7. cascade — Cost-Aware Fallthrough

```ts
await workflow("answer")
  .pattern("cascade")
  .agent("haiku",  { cli: "claude", model: "claude-haiku-4-5-20251001" })
  .agent("sonnet", { cli: "claude", model: "claude-sonnet-4-6" })
  .agent("opus",   { cli: "claude", model: "claude-opus-4-7" })
  .step("try-haiku",  { agent: "haiku",  task: "{{question}}" })
  .step("try-sonnet", { agent: "sonnet",
                        task: "If this is a complete answer, echo it verbatim. Otherwise answer anew:\n{{steps.try-haiku.output}}",
                        dependsOn: ["try-haiku"] })
  .step("try-opus",   { agent: "opus",
                        task: "Final-tier answer, using prior attempts for context:\n{{steps.try-sonnet.output}}",
                        dependsOn: ["try-sonnet"] })
  .run();
```

#### 8. dag — Directed Acyclic Graph

```ts
await workflow("fullstack")
  .pattern("dag")
  .maxConcurrency(3)
  .agent("dev", { cli: "codex", role: "worker" })
  .step("scaffold",  { agent: "dev", task: "Create project scaffold" })
  .step("frontend",  { agent: "dev", task: "Build React UI", dependsOn: ["scaffold"] })
  .step("backend",   { agent: "dev", task: "Build API",       dependsOn: ["scaffold"] })
  .step("integrate", { agent: "dev", task: "Wire together",   dependsOn: ["frontend", "backend"] })
  .run();
```

#### 9. debate — Adversarial Refinement

```yaml
swarm: { pattern: debate }
agents:
  - { name: pro,   cli: claude, role: debater, task: "Argue FOR monorepo" }
  - { name: con,   cli: claude, role: debater, task: "Argue FOR polyrepo" }
  - { name: judge, cli: claude, role: judge,   task: "Decide after 3 rounds" }
coordination:
  barriers:
    - { name: debate-done, waitFor: [pro-round-3, con-round-3] }
```

#### 10. hierarchical — Multi-Level (structurally hub-spoke today)

```ts
await workflow("large-team")
  .pattern("hierarchical")
  .agent("lead",     { cli: "claude", role: "lead" })
  .agent("fe-coord", { cli: "claude", role: "coordinator" })
  .agent("be-coord", { cli: "claude", role: "coordinator" })
  .agent("fe-dev",   { cli: "codex",  role: "worker", interactive: false })
  .agent("be-dev",   { cli: "codex",  role: "worker", interactive: false })
  .step("plan",    { agent: "lead",     task: "Coordinate full-stack app" })
  .step("fe-plan", { agent: "fe-coord", task: "Manage frontend",  dependsOn: ["plan"] })
  .step("be-plan", { agent: "be-coord", task: "Manage backend",   dependsOn: ["plan"] })
  .step("fe-impl", { agent: "fe-dev",   task: "Build components", dependsOn: ["fe-plan"] })
  .step("be-impl", { agent: "be-dev",   task: "Build API",        dependsOn: ["be-plan"] })
  .run();
```


### Verification & Completion Signals

#### An agent step can complete in several ways (`runner.ts:5353-5395`, `runner.ts:4527-4538`):

```yaml
verification:
  type: output_contains   # or: exit_code | file_exists | custom
  value: DONE             # or: PLAN_COMPLETE, IMPLEMENTATION_COMPLETE, REVIEW_COMPLETE
```


### Relaycast MCP — Correct Tool Names

The skill previously referenced `mcp__relaycast__send` / `mcp__relaycast__dm` — those names are wrong. The real tools (the first three are cited in the workflow convention-injection at `relay-adapter.ts:31-35`; the rest are exposed by the live `relaycast` MCP server):

| Purpose | Tool | Source |
|---------|------|--------|
| Send DM to another agent | `mcp__relaycast__message_dm_send` | `relay-adapter.ts:31` |
| Check inbox | `mcp__relaycast__message_inbox_check` | `relay-adapter.ts:35` |
| List agents | `mcp__relaycast__agent_list` | `relay-adapter.ts:35` |
| Post to a channel | `mcp__relaycast__message_post` | relaycast MCP server |
| Reply in a thread | `mcp__relaycast__message_reply` | relaycast MCP server |
| Spawn sub-agent | `mcp__relaycast__agent_add` | relaycast MCP server |
| Remove sub-agent | `mcp__relaycast__agent_remove` | relaycast MCP server |

> `interactive: false` agents run as non-interactive subprocesses with no relay connection — they must NOT call any `mcp__relaycast__*` tool (validator warns on this at `validator.ts:138-150`, check `NONINTERACTIVE_RELAY`).

### Reflection (Trajectories)

#### Reflection is **not** a `reflectionThreshold` callback. It's configured via the `trajectories:` block:

```yaml
trajectories:
  enabled: true
  reflectOnBarriers: true   # config flag exists but runner does NOT currently invoke this path
  reflectOnConverge: true   # fires at parallel convergence points (runner.ts:2762-2779)
  autoDecisions: true       # record retry/skip/fail decisions
```


### Common Mistakes

| Mistake | Why It Fails | Fix |
|---------|-------------|-----|
| Using mesh/debate for everything | Full-mesh blows up message volume past ~5 agents | Use hub-spoke or dag for most tasks |
| Pipeline for independent work | Sequential bottleneck | Use fan-out or dag |
| Hub-spoke for 2 agents | Hub is unnecessary overhead | Use pipeline or fan-out |
| Expecting `consensusStrategy` to tally votes | Runner has no vote-tally logic; field only affects coordinator auto-selection | Aggregate votes in a judge/lead step that reads `{{steps.*.output}}` |
| Handoff with "routing = skip other branches" | Skipping only fires on upstream **failure**, not routing decisions | Emit a routing token in triage output; downstream prompts self-no-op if token doesn't match |
| Cascade expecting skip-on-success | Runner has no cascade skip logic; failed upstream skips downstream | Chain downstream prompts to pass-through or redo based on `{{steps.previous.output}}` |
| Relying on `reflectOnBarriers` | Config flag exists but runner never calls it | Use `reflectOnConverge` for convergence reflection; use `reflection` pattern for critic loops |
| `interactive: false` agent calling MCP | Non-interactive subprocess has no relay | Use `interactive: true` (default) or emit output on stdout |
| Relying on multi-level `hierarchical` | Topology is single-level hub in current impl | Use pattern for naming; model levels via `dependsOn` graph |
| Writing `mcp__relaycast__send(...)` | Wrong tool name | Use `mcp__relaycast__message_post` or `message_dm_send` |

### Resume & Re-run

#### ```ts

```ts
// Resume a failed run:
await runWorkflow("feature-dev.yaml", { resume: "<runId>" });

// Skip ahead, re-using cached outputs from an earlier run:
await runWorkflow("feature-dev.yaml", {
  startFrom: "review",
  previousRunId: "<runId>",
});
```


### Complete YAML Example

#### ```yaml

```yaml
version: "1.0"
name: feature-dev
description: "Blueprint-style feature development with quality gates."
swarm:
  pattern: hub-spoke
  maxConcurrency: 2
  timeoutMs: 3600000
  channel: swarm-feature-dev
  idleNudge: { nudgeAfterMs: 120000, escalateAfterMs: 120000, maxNudges: 1 }
agents:
  - { name: lead,      cli: claude, role: lead,     permissions: { access: full } }
  - { name: planner,   cli: codex,  role: planner,  interactive: false, permissions: { access: readonly } }
  - { name: developer, cli: codex,  role: worker,   interactive: false, permissions: { access: readwrite } }
  - { name: reviewer,  cli: claude, role: reviewer, permissions: { access: readonly } }
workflows:
  - name: feature-delivery
    onError: retry
    preflight:
      - { command: "git status --porcelain", failIf: non-empty, description: "Clean worktree" }
    steps:
      - name: plan
        agent: planner
        task: "Plan: {{task}}"
        verification: { type: output_contains, value: PLAN_COMPLETE }
      - name: implement
        agent: developer
        dependsOn: [plan]
        task: "Implement: {{steps.plan.output}}"
        verification: { type: output_contains, value: IMPLEMENTATION_COMPLETE }
      - name: test
        type: deterministic
        dependsOn: [implement]
        command: npm test
      - name: review
        agent: reviewer
        dependsOn: [test]
        task: "Review implementation"
        verification: { type: output_contains, value: REVIEW_COMPLETE }
coordination:
  barriers:
    - { name: delivery-ready, waitFor: [plan, implement, review], timeoutMs: 900000 }
trajectories:
  enabled: true
  reflectOnBarriers: true
  reflectOnConverge: true
errorHandling:
  strategy: retry
  maxRetries: 2
  retryDelayMs: 5000
```


### Source of Truth

| Claim | File |
|-------|------|
| Pattern enum (24 patterns) | `packages/sdk/src/workflows/types.ts:114-139` |
| Topology resolution per pattern | `packages/sdk/src/workflows/coordinator.ts:240-450` |
| Interactive-only topology edges | `packages/sdk/src/workflows/coordinator.ts:218-237` |
| Pattern auto-selection heuristics (programmatic API only) | `packages/sdk/src/workflows/coordinator.ts:51-165` |
| `WorkflowBuilder` fluent API | `packages/sdk/src/workflows/builder.ts` |
| `runWorkflow(yamlPath, options)` | `packages/sdk/src/workflows/run.ts` |
| YAML validation requires `version` + `name` + `swarm.pattern` | `packages/sdk/src/workflows/runner.ts:2105-2117` |
| MCP tool names cited in convention-injection | `packages/sdk/src/relay-adapter.ts:29-36` |
| Completion modes (verification / evidence / owner / process-exit) | `packages/sdk/src/workflows/runner.ts:5353-5395`, `4527-4538` |
| Completion via PTY + summary fallback | `packages/sdk/src/workflows/runner.ts:6600-6615` |
| Downstream skip on upstream failure (not success) | `packages/sdk/src/workflows/runner.ts:7057-7088`, `step-executor.ts:329-334` |
| Trajectory reflection (only `reflectOnConverge` wired) | `packages/sdk/src/workflows/runner.ts:2762-2779`, `trajectory.ts:173-190` |


# relay-80-100-workflow
reason=Spec text mentions "writing". Spec text mentions "must". Spec text mentions "before". Spec text mentions "covers". Spec text mentions "code". Spec text mentions "works". Spec text mentions "validation". Spec text mentions "test". Spec text mentions "mock". Spec text mentions "after". Spec text mentions "every". Spec text mentions "full". Spec text mentions "implementation". Spec text mentions "through". Spec text mentions "tests".
---
name: relay-80-100-workflow
description: Use when writing agent-relay workflows that must fully validate features end-to-end before merging. Covers the 80-to-100 pattern - going beyond "code compiles" to "feature works, tested E2E locally." Includes repair-before-failure validation gates, review-depth fresh-eyes review/fix loops with test hardening, PGlite for in-memory Postgres testing, mock sandbox patterns, test-fix-rerun loops, verify gates after every edit, and the full lifecycle from implementation through passing tests to commit.
---

### Overview

Most agent workflows get features to ~80%: code written, types check, maybe a build passes. This skill covers the **80-to-100 gap** — making workflows that fully validate features end-to-end before committing. The goal: every feature merged via these workflows is **tested, verified, and known-working**, not just "it compiles."

### When to Use

- Writing workflows where the deliverable must be **production-ready**, not just code-complete
- Features that touch databases, APIs, or infrastructure that can be tested locally
- Any workflow where "it compiles" is not sufficient proof of correctness
- When you want confidence that the commit actually works before deploying

### Core Principle: Test In The Workflow

#### The key insight: **run tests as deterministic steps inside the workflow itself**. Don't just write test files — execute them, verify they pass, fix failures, and re-run. The workflow doesn't commit until tests are green.

```
implement → write tests → run tests → fix failures → re-run → build check → regression check → commit
```


### Repair Before Failure

An 80-to-100 workflow should not stop merely because a test, typecheck, lint, schema, or E2E gate turns red. That red output is work for the agent team. Capture it, hand it to a repair owner, fix it, and rerun. Workflow-owned validation gates should never terminate the run with `FAILED`. If the team exhausts its repair budget or hits an external blocker such as missing credentials, wrong repository, or unsafe dirty worktree, write a `BLOCKED_NO_COMMIT` artifact and end without committing or opening a PR instead of crashing the workflow.

Use this shape for every meaningful gate:

1. `run-*`: deterministic command with `captureOutput: true` and `failOnError: false`.
2. `fix-*`: agent step that reads `{{steps.run-*.output}}`, fixes source/tests/config, and reruns the command locally until green.
3. `verify-*`: deterministic rerun, usually still `failOnError: false`, followed by a final repair step if red.
4. `commit-if-green`: deterministic step that reruns the full acceptance command and commits only when every exit code is zero. If anything is still red, it writes `BLOCKED_NO_COMMIT` with the failing evidence and exits successfully so the workflow reports a handled blocked state, not a runtime failure.

AgentWorkforce/relay#827 added repair-aware reliability to the SDK (`.reliable()` / `.repairable()` and repair-aware retry-mode workflows). Prefer those presets when available, but still model explicit repair owners when gate output needs domain-specific fixing.

### Keep Repairable Gates On The Critical Path

Repair-before-failure only works after the workflow reaches a deterministic gate. If a long-running interactive agent step is a hard dependency for the first gate, then a dropped PTY, agent spawn error, or transport failure can stop the workflow before the repair loop ever sees evidence.

For large rollouts, treat implementation agents as advisory producers and put a deterministic reconciliation step on the critical path:

1. Start implementation/review agents in parallel if useful, but require them to write durable artifacts such as `.workflow-artifacts/<task>/runtime.md`, self-review notes, changed-file lists, and command evidence.
2. Add `implementation-reconcile`: a deterministic step that inspects `git status --short -- <paths>`, required files, artifact files, and diff stats. It should use `captureOutput: true` and `failOnError: false`.
3. Add `repair-implementation-reconcile`: a focused repair owner that reads the reconcile output and finishes missing artifacts or code before validation gates run.
4. Make discovery, typecheck, E2E, and final acceptance depend on the reconcile/repair path, not directly on every long-lived implementation agent.
5. Keep the final commit deterministic and green-only; red final evidence becomes a repair/blocking artifact, not a failed workflow.

This shape prevents "agent transport failed" from masquerading as "the product failed." The product still has to pass the same gates; the difference is that the workflow can reach the gates and repair them.

### Squad Review Before Final Acceptance

For high-stakes implementation workflows, validation should include human-like review structure, not only command gates. Use small implementation squads and make review state durable:

1. Split independent scopes into 2-3 agent squads. Each squad has an implementer, a shadow reviewer, and optionally a validation/test owner.
2. The shadow reviewer follows the implementer while work is happening and flags spec drift early.
3. Before external review, the implementer writes a self-reflection artifact under `.workflow-artifacts/<task>/` covering spec coverage, changed files, tests/proofs, repo-rule alignment, and known risks.
4. A fresh self-review agent reads the actual files, AGENTS.md / CLAUDE.md, recent related work, and local conventions. It writes findings to disk.
5. The implementer repairs valid findings, then deterministic gates rerun from captured output.
6. After all squads converge, run the selected review-depth fresh-eyes review/fix path. Light requires `review-claude` -> `fix-loop` and gates final review pass on `post-fix-validation`. Standard adds `final-review-claude` -> `final-fix-claude` and gates final review pass on `final-fix-claude`. Deep requires the standard Claude path plus `review-codex` -> `fix-loop-codex` -> `final-review-codex` -> `final-fix-codex` and gates final review pass on `final-fix-codex`.
7. If the selected review path still finds issues, run another explicit fix pass or write `BLOCKED_NO_COMMIT` with exact evidence.
8. Commit or PR creation is allowed only after the selected review-depth path, final-review-pass gate, final deterministic acceptance, and scoped diff/regression gates are green. Otherwise write a `BLOCKED_NO_COMMIT` artifact with exact evidence.

This keeps "100%" tied to both executable evidence and independent review over the final state.

### The Test-Fix-Rerun Pattern

#### Every testable feature in a workflow should follow this four-step pattern:

```typescript
// Step 1: Run tests (allow failure — we expect issues on first run)
.step('run-tests', {
  type: 'deterministic',
  dependsOn: ['create-tests'],
  command: 'npx tsx --test tests/my-feature.test.ts 2>&1 | tail -60',
  captureOutput: true,
  failOnError: false,  // <-- Don't fail the workflow, let the agent fix it
})

// Step 2: Agent reads output, fixes issues, re-runs until green
.step('fix-tests', {
  agent: 'tester',
  dependsOn: ['run-tests'],
  task: `Check the test output and fix any failures.

Test output:
{{steps.run-tests.output}}

If all tests passed, do nothing.
If there are failures:
1. Read the failing test file and source files
2. Fix the issues (could be in test or source)
3. Re-run: npx tsx --test tests/my-feature.test.ts
4. Keep fixing until ALL tests pass.`,
  verification: { type: 'exit_code' },
})

// Step 3: Deterministic rerun — capture result for a final repair pass
.step('run-tests-final', {
  type: 'deterministic',
  dependsOn: ['fix-tests'],
  command: 'npx tsx --test tests/my-feature.test.ts 2>&1',
  captureOutput: true,
  failOnError: false,
})

// Step 4: Repair again if the rerun is still red
.step('fix-tests-final', {
  agent: 'tester',
  dependsOn: ['run-tests-final'],
  task: `If the final test rerun passed, record the green evidence.
If it failed, fix the remaining issue and rerun until green:
{{steps.run-tests-final.output}}`,
  verification: { type: 'exit_code' },
})
```


### PGlite: In-Memory Postgres for Database Testing

#### Setup

```typescript
.step('install-pglite', {
  type: 'deterministic',
  command: 'npm install --save-dev @electric-sql/pglite 2>&1 | tail -5',
  captureOutput: true,
})
```

#### Test Helper Pattern

```typescript
// tests/helpers/pglite-db.ts
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../packages/web/lib/db/schema.js';

// Raw DDL matching your Drizzle schema — PGlite doesn't run Drizzle migrations
const MY_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS my_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export async function createTestDb() {
  const pg = new PGlite();
  await pg.exec(MY_TABLE_DDL);
  const db = drizzle(pg, { schema });
  return { db, pg, schema, cleanup: () => pg.close() };
}
```

#### Test Structure

```typescript
// tests/my-feature.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb } from './helpers/pglite-db.js';

describe('my feature', () => {
  it('does the thing correctly', async () => {
    const { db, schema, cleanup } = await createTestDb();
    try {
      // Arrange
      const testId = randomUUID();
      // Act — use your module against the real (in-memory) Postgres
      // Assert
      assert.equal(result.name, 'expected');
    } finally {
      await cleanup();
    }
  });
});
```


### Verify Gates After Every Edit

#### Never trust that an agent edited a file correctly. Add a deterministic verify gate after every agent edit step:

```typescript
// Agent edits a file
.step('edit-schema', {
  agent: 'impl',
  dependsOn: ['read-schema'],
  task: `Edit packages/web/lib/db/schema.ts...`,
  verification: { type: 'exit_code' },
})

// Deterministic verification — did the edit actually land?
.step('verify-schema', {
  type: 'deterministic',
  dependsOn: ['edit-schema'],
  command: `if git diff --quiet packages/web/lib/db/schema.ts; then echo "NOT MODIFIED"; exit 1; fi
grep "my_new_table" packages/web/lib/db/schema.ts >/dev/null && echo "OK" || (echo "MISSING"; exit 1)`,
  failOnError: false,
  captureOutput: true,
})
.step('fix-schema-verification', {
  agent: 'impl',
  dependsOn: ['verify-schema'],
  task: `Fix the schema edit if verification failed. Output:\n{{steps.verify-schema.output}}`,
  verification: { type: 'exit_code' },
})
```

#### Edit Gates That Include New Files

```typescript
.step('edit-gate-capture', {
  type: 'deterministic',
  dependsOn: ['implement'],
  command: `if [ -z "$(git status --short -- packages/new-adapter tests docs)" ]; then
  echo "NO_CHANGES"
  exit 1
fi
echo "EDIT_GATE_OK"`,
  captureOutput: true,
  failOnError: false,
})
.step('fix-edit-gate', {
  agent: 'impl',
  dependsOn: ['edit-gate-capture'],
  task: `If the edit gate reported NO_CHANGES, inspect the acceptance contract
and current git status, then add the missing source/test/artifacts.

Gate output:
{{steps.edit-gate-capture.output}}

If it already passed, do nothing.`,
  verification: { type: 'exit_code' },
})
.step('edit-gate-final', {
  type: 'deterministic',
  dependsOn: ['fix-edit-gate'],
  command: `if [ -z "$(git status --short -- packages/new-adapter tests docs)" ]; then
  echo "NO_CHANGES"
  exit 1
fi
echo "EDIT_GATE_FINAL_OK"`,
  captureOutput: true,
  failOnError: true,
})
```


### Mock Sandbox Pattern

#### When testing code that interacts with Daytona sandboxes, use inline mock objects matching the existing test conventions:

```typescript
const daytona = {
  create: async () => ({
    id: 'sandbox-id',
    process: {
      executeCommand: async (cmd, cwd, env) => ({
        result: 'output',
        exitCode: 0,
      }),
    },
    fs: {
      uploadFile: async () => undefined,
    },
    getUserHomeDir: async () => '/home/daytona',
  }),
  remove: async () => undefined,
};
```


### Regression Testing

#### After your new tests pass, always run the **existing test suite** to catch regressions:

```typescript
.step('run-existing-tests', {
  type: 'deterministic',
  dependsOn: ['fix-build'],
  command: 'npm run orchestrator:test 2>&1 | tail -40',
  captureOutput: true,
  failOnError: false,
})

.step('fix-regressions', {
  agent: 'impl',
  dependsOn: ['run-existing-tests'],
  task: `Check the full test suite for regressions caused by our changes.

Test output:
{{steps.run-existing-tests.output}}

If all tests passed, do nothing.
If EXISTING tests broke, read the failing test, find what we broke, fix it.
Most likely cause: constructor signatures changed, new required fields added
without defaults, or import paths shifted.

Run: npm run orchestrator:test
Fix until all tests pass.`,
  verification: { type: 'exit_code' },
})
```


### Full Workflow Template

#### Here's the complete pattern for a feature that touches the database:

```typescript
import { workflow } from '@agent-relay/sdk/workflows';

const result = await workflow('my-feature')
  .description('Add feature X with full E2E validation')
  .pattern('dag')
  .channel('wf-my-feature')
  .maxConcurrency(3)
  .timeout(3_600_000)
  .repairable()

  .agent('impl', { cli: 'claude', preset: 'worker', retries: 2 })
  .agent('tester', { cli: 'claude', preset: 'worker', retries: 2 })

  // ── Phase 1: Read ────────────────────────────────────────────────
  .step('read-target', {
    type: 'deterministic',
    command: 'cat path/to/file.ts',
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────
  .step('edit-target', {
    agent: 'impl',
    dependsOn: ['read-target'],
    task: `Edit path/to/file.ts. Current contents:
{{steps.read-target.output}}
<specific instructions>
Only edit this one file.`,
    verification: { type: 'exit_code' },
  })
  .step('verify-target', {
    type: 'deterministic',
    dependsOn: ['edit-target'],
    command: 'git diff --quiet path/to/file.ts && (echo "NOT MODIFIED"; exit 1) || echo "OK"',
    failOnError: false,
    captureOutput: true,
  })
  .step('fix-target-verification', {
    agent: 'impl',
    dependsOn: ['verify-target'],
    task: `Fix the target edit if verification failed. Output:\n{{steps.verify-target.output}}`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 3: Test infrastructure ─────────────────────────────────
  .step('install-pglite', {
    type: 'deterministic',
    command: 'npm install --save-dev @electric-sql/pglite 2>&1 | tail -5',
    captureOutput: true,
  })
  .step('create-test-helpers', {
    agent: 'tester',
    dependsOn: ['install-pglite'],
    task: 'Create tests/helpers/pglite-db.ts with <DDL for your tables>...',
    verification: { type: 'file_exists', value: 'tests/helpers/pglite-db.ts' },
  })
  .step('create-tests', {
    agent: 'tester',
    dependsOn: ['create-test-helpers', 'fix-target-verification'],
    task: 'Create tests/my-feature.test.ts with <test descriptions>...',
    verification: { type: 'file_exists', value: 'tests/my-feature.test.ts' },
  })

  // ── Phase 4: Test-fix-rerun loop ─────────────────────────────────
  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['create-tests'],
    command: 'npx tsx --test tests/my-feature.test.ts 2>&1 | tail -60',
    captureOutput: true,
    failOnError: false,
  })
  .step('fix-tests', {
    agent: 'tester',
    dependsOn: ['run-tests'],
    task: `Fix any test failures. Output:\n{{steps.run-tests.output}}`,
    verification: { type: 'exit_code' },
  })
  .step('run-tests-final', {
    type: 'deterministic',
    dependsOn: ['fix-tests'],
    command: 'npx tsx --test tests/my-feature.test.ts 2>&1',
    captureOutput: true,
    failOnError: false,
  })
  .step('fix-tests-final', {
    agent: 'tester',
    dependsOn: ['run-tests-final'],
    task: `If the final test rerun is red, fix and rerun until green. Output:\n{{steps.run-tests-final.output}}`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 5: Build + regression ──────────────────────────────────
  .step('build-check', {
    type: 'deterministic',
    dependsOn: ['fix-tests-final'],
    command: 'npx tsc --noEmit 2>&1 | tail -20; echo "EXIT: $?"',
    captureOutput: true,
    failOnError: false,
  })
  .step('fix-build', {
    agent: 'impl',
    dependsOn: ['build-check'],
    task: `Fix type errors if any. Output:\n{{steps.build-check.output}}`,
    verification: { type: 'exit_code' },
  })
  .step('run-existing-tests', {
    type: 'deterministic',
    dependsOn: ['fix-build'],
    command: 'npm test 2>&1 | tail -40',
    captureOutput: true,
    failOnError: false,
  })
  .step('fix-regressions', {
    agent: 'impl',
    dependsOn: ['run-existing-tests'],
    task: `Fix regressions if any. Output:\n{{steps.run-existing-tests.output}}`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 6: Commit ──────────────────────────────────────────────
  .step('commit', {
    type: 'deterministic',
    dependsOn: ['fix-regressions'],
    command: [
      'npx tsx --test tests/my-feature.test.ts',
      'npm test',
      'git add <files>',
      'git commit -m "feat: ..."',
    ].join(' && '),
    captureOutput: true,
    failOnError: false,
  })
  .step('repair-commit', {
    agent: 'impl',
    dependsOn: ['commit'],
    task: `If commit failed, fix the blocker, rerun the feature and regression tests, and create the commit.
If commit passed, confirm the commit subject.
Output:
{{steps.commit.output}}`,
    verification: { type: 'exit_code' },
  })
  .step('verify-commit-created', {
    type: 'deterministic',
    dependsOn: ['repair-commit'],
    command: 'git log -1 --pretty=%s | grep -q "^feat: " && echo "COMMIT_OK" || (echo "COMMIT_MISSING"; exit 1)',
    captureOutput: true,
    failOnError: true,
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({ cwd: process.cwd() });
```


### Checklist: Is Your Workflow 80-to-100?

| Check | How |
|-------|-----|
| Tests exist | `file_exists` verification on test file |
| Tests actually run | Deterministic step executes them |
| Test failures get fixed | Agent step reads output, fixes, re-runs |
| Final test run is repairable | Deterministic rerun captures output, then a repair owner gets one more pass |
| Build passes | `npx tsc --noEmit` deterministic step |
| No regressions | Existing test suite runs after changes |
| Every edit is verified and repairable | `git diff --quiet` + grep for tracked-only edits; `git status --short -- <paths>` when new files/packages may appear; then a fix step |
| Commit only happens after green evidence | Final commit step reruns acceptance checks and commits only on zero exit codes |

### Common Anti-Patterns

| Anti-pattern | Why it fails | Fix |
|-------------|-------------|-----|
| Tests written but never executed | Agent claims they pass, they don't | Add deterministic `run-tests` step |
| Single `failOnError: true` test run | First failure kills workflow, no chance to fix | Use repairable run-fix-rerun-final-fix loops |
| No regression test | New feature works, old features break | Run `npm test` after build check |
| Agent asked to "write and run tests" in one step | Agent writes tests, runs them, they fail, it edits, output is garbled | Separate write/run/fix into distinct steps |
| PGlite DDL doesn't match Drizzle schema | Tests pass on wrong schema | Derive DDL from schema.ts or test with real migration |
| Final test output not handed to an agent | Broken tests can stop the run or get ignored | Add a final repair owner before commit |
| Testing only happy path | Edge cases break in prod | Specify edge case tests in the task prompt |
| No verify gate after agent edits | Agent exits 0 without writing anything | Add `git diff --quiet` check after every edit, then route failures to a repair step |
| `git diff --quiet` for new package/test directories | Untracked files are invisible, so valid new artifacts can look like "no changes" | Use `git status --short -- <paths>` and a repairable capture → fix → final gate pattern |
| Committing after `failOnError: false` without checking exits | Broken work can be committed because the shell step returned successfully | In `commit-if-green`, record each exit code and skip commit unless all are zero |


# review-fix-signoff-loop
reason=Spec text mentions "writing". Spec text mentions "agent". Spec text mentions "relay". Spec text mentions "must". Spec text mentions "validation". Spec text mentions "independent". Spec text mentions "agents". Spec text mentions "both". Spec text mentions "work". Spec text mentions "covers".
---
name: review-fix-signoff-loop
description: Use when writing Agent Relay or Ricky workflows that must loop review, fix, and validation with fresh agent context until independent signoff agents, typically Claude and Codex, both agree the work is comprehensively complete. Covers fresh-context iterations, repairable gates, dual reviewer verdict contracts, iteration-count reporting, PR signoff comments, and blocked-state handling.
---

### Purpose

Use this pattern for high-stakes implementation workflows where a normal "implement, test, review once" flow is not enough. The workflow must keep repairing and re-reviewing until independent signoff agents agree the spec is fully wired end to end.

Pair this with `writing-agent-relay-workflows` for SDK syntax and `relay-80-100-workflow` for deterministic validation gates.

### Required Shape

- Run deterministic preflight before agents start.
- Confirm repository root, required specs, declared write scope, credentials needed for PR comments, and whether commit/push/PR creation is in scope.
- For cross-repo or package-release work, write a scope matrix before implementation: repositories, branches, PRs, packages, providers/features touched, published versions, consuming package manifests, lockfiles, and expected downstream bumps.
- Probe the CLIs used by later agent steps. For Codex, `codex login status` is not enough; run a tiny `codex exec --ephemeral --json --sandbox read-only -m <supported-model>` prompt and fail early with a clear re-login instruction if it cannot return the expected token.
- Write preflight evidence to `.workflow-artifacts/<workflow>/iteration-N/preflight.md`.
- Implement with scoped owners.
- Use Codex workers for code changes unless the codebase has a reason to prefer another CLI.
- Split backend, frontend, desktop, tests, docs, or infrastructure into explicit non-overlapping ownership areas.
- Each worker writes a durable summary artifact with changed files and commands run.
- Reconcile before validation.
- Add a deterministic `implementation-reconcile` gate that checks required files, expected API/UI/runtime surfaces, migrations, generated artifacts, and untracked files with `git status --short -- <paths>`.
- For multi-provider changes, reconcile against the scope matrix: every touched provider/package must be classified as `implemented`, `dependency-only`, `intentionally-deferred`, or `not-applicable`, with proof. Do not let "we only bumped the package I remembered" pass this gate.
- For package-release flows, reconcile producer and consumer state: `npm view <pkg> version`, package manifests, lockfile resolved tarballs/integrities, and `npm ls <pkg>` from every consuming workspace.
- For CI failures, map each failing job to its exact local command or documented non-local equivalent. Distinguish similarly named gates (for example handler coverage vs acceptance route coverage) and replay the one that actually failed.
- Use `failOnError: false`, then route the captured output to a repair owner.
- Run repairable validation.
- Use capture -> fix -> rerun for typecheck, targeted tests, integration or E2E tests, and regression checks.
- Include exact failing CI commands when available before broader "nearby" checks. A nearby green gate is supporting evidence, not proof that the reported CI failure is fixed.
- Red validation output is input for a repair agent, not an immediate workflow failure.
- Write `BLOCKED_NO_COMMIT.md` only for true external blockers.
- Run fresh-context signoff reviews.
- Start a new workflow run, new agent names, or otherwise new agent contexts for each loop iteration.
- Run Claude and Codex signoff reviews independently over the same post-validation repo state.
- Reviewers must read specs, diff, validation logs, artifacts, and actual files.
- Break only on dual signoff.
- The loop may exit only when both reviewers write the exact satisfied verdict and final deterministic acceptance is green.
- If either reviewer finds issues or is blocked, run a Codex fix pass and start a new fresh-context review iteration.
- Make the Codex fix pass a non-interactive one-shot worker (`preset: 'worker'`) with a `file_exists` verification for its durable report. Do not rely on interactive PTY idle detection or `/exit` for loop progress.
- Report final signoff.
- Write a final `SIGNOFF.md` that includes iteration count, validation evidence, Claude rationale, Codex rationale, remaining risks, and artifact paths.
- Include the final scope matrix with every repository/package/provider row signed off, deferred with owner/date, or marked not applicable. For release flows, include published and consumed versions.
- Post the same report to the PR. Resolve the PR from an explicit env var first, then from `gh pr view`.

### Verdict Contract

#### Use a strict text contract so deterministic gates can parse the result:

```text
VERDICT: COMPREHENSIVELY_SATISFIED | FINDINGS | BLOCKED
why_passed: required when VERDICT is COMPREHENSIVELY_SATISFIED
end_to_end_wiring_verified: required when VERDICT is COMPREHENSIVELY_SATISFIED
deterministic_evidence: required when VERDICT is COMPREHENSIVELY_SATISFIED
scope_matrix_verified: required when VERDICT is COMPREHENSIVELY_SATISFIED for cross-repo/provider/package work
remaining_risks: required when VERDICT is COMPREHENSIVELY_SATISFIED
finding_id: stable-id when VERDICT is FINDINGS
severity: blocker | high | medium | low
file: path
issue: concrete gap
fix_required: exact change needed
test_required: deterministic proof needed
evidence: commands, files, or spec clause
```


### Scope Matrix

#### Create a machine-readable and human-readable matrix before the first fix pass for work that spans repositories, packages, providers, or CI gates. Keep it updated every iteration.

```text
repo | branch | PR | package/provider/surface | expected change | producer version | consumer version | files expected | gates required | status | evidence | owner
```


### Fresh Context Implementation

#### Prefer an outer loop that starts a new Agent Relay workflow run per iteration:

```typescript
for (let iteration = 1; ; iteration += 1) {
  await runIteration(iteration, runStamp); // new workflow name, channel, and agent names
  clearStartFromAfterResumedIteration();
  if (hasDualSignoff(iteration)) {
    writeAndPostSignoffReport(iteration);
    break;
  }
}
```


### Codex Fixer Reliability

#### For review-fix loop steps, prefer this shape:

```typescript
.agent(`codex-review-fixer-${suffix}`, {
  cli: 'codex',
  model: CodexModels.GPT_5_4,
  preset: 'worker',
  role: 'Review-finding fixer. Repairs valid findings and hardens tests/proofs.',
  retries: 2,
})
.step('fix-review-findings', {
  agent: `codex-review-fixer-${suffix}`,
  dependsOn: ['dual-signoff-gate'],
  task: `Read iteration artifacts. Fix every valid finding, rerun relevant checks, and write ${dir}/review-fix-report.md.`,
  verification: { type: 'file_exists', value: `${ROOT}/${dir}/review-fix-report.md` },
})
```


### PR Signoff Comment

#### Final signoff should be both a durable artifact and a PR comment.

```bash
gh pr comment "$PR_NUMBER" --body-file .workflow-artifacts/my-workflow/pr-comment.md
```


### Blocked State

#### Do not spin forever when progress is impossible. If agents identify a true external blocker, write:

```text
.workflow-artifacts/<workflow>/iteration-N/BLOCKED_NO_COMMIT.md
```


### Common Mistakes

- Reusing the same reviewer context every loop. Start a new run or new reviewer agents for each iteration.
- Letting a reviewer write `NO_ISSUES_FOUND` without pass rationale. Require the full verdict contract.
- Treating green tests as signoff. Green deterministic gates are required evidence, not a substitute for fresh review.
- Hard-failing the first red validation gate. Capture it, repair it, then rerun.
- Posting a PR comment before both signoff agents agree on the same final state.
- Forgetting to count iterations. The final report must say how many loops it took.


# writing-agent-relay-workflows
reason=Spec text mentions "building". Spec text mentions "relay". Spec text mentions "covers". Spec text mentions "agents". Spec text mentions "test". Spec text mentions "error". Spec text mentions "event".
---
name: writing-agent-relay-workflows
description: Use when building multi-agent workflows with relay broker-sdk. Covers conversation vs pipeline coordination, WorkflowBuilder/DAG steps, agents, {{steps.X.output}} chaining, repairable verification gates, evidence-based completion, review-depth fresh-eyes review/fix loops with test hardening, channels, chat-native recipes, error handling, event listeners, step sizing, lead+workers teams, and parallel waves.
---

### Overview

The relay broker-sdk workflow system orchestrates multiple AI agents (Claude, Codex, Gemini, Aider, Goose) through typed DAG-based workflows. Workflows can be written in **TypeScript** (preferred), **Python**, or **YAML**.

**Language preference:** TypeScript > Python > YAML. Use TypeScript unless the project is Python-only or a simple config-driven workflow suits YAML.

**Pattern selection:** Do not default to `dag` blindly. If the job needs a different swarm/workflow type, consult the `choosing-swarm-patterns` skill when available and select the pattern that best matches the coordination problem.

### When to Use

- Building multi-agent workflows with step dependencies
- Orchestrating different AI CLIs (claude, codex, gemini, aider, goose)
- Creating DAG, pipeline, fan-out, or other swarm patterns
- Needing verification gates, retries, or step output chaining
- Designing product-contract workflows where failing checks should route to agents for repair instead of stopping the run
- Dynamic channel management: agents joining/leaving/muting channels mid-workflow

### Non-Negotiable Workflow Checklist

Every generated workflow should satisfy this checklist before it is considered complete:

1. Start with a deterministic, resumable preflight for repository state, credentials, and declared write scope.
2. Pick the coordination shape deliberately: Conversation for non-trivial coordination, Pipeline only for linear one-shot handoffs.
3. Use repairable validation gates: capture red output with `failOnError: false`, hand it to a repair owner, then rerun the same check.
4. Run fresh-eyes review at the depth warranted by the spec: deep-tier workflows use Claude review/fix/final review/final fix followed by Codex review/fix/final review/final fix; lighter generated workflows may scale down only when deterministic gates, hard validation, and at least one independent Claude review/fix pass remain on the critical path.
5. Require review fixers to add or update appropriate tests, fixtures, assertions, or deterministic proofs for testable findings.
6. Run final deterministic acceptance after the selected review-depth path and before commit, PR creation, or handoff.
7. If a real blocker remains, write `BLOCKED_NO_COMMIT` with exact evidence and skip commit/PR creation instead of crashing the workflow.
8. If the workflow owns shipping, model branch, commit, push, PR creation, and PR URL verification as explicit deterministic steps.

### Default Principle: Workflows Repair Before They Fail

- Run deterministic checks as evidence-capturing gates with `captureOutput: true`.
- Prefer `failOnError: false` for intermediate validation gates so the workflow can pass the output to a repair agent.
- Add a repair step immediately after each red-prone gate. The repair agent reads `{{steps.<gate>.output}}`, fixes source/tests/config, reruns the same command locally, and exits only after the gate is green or the blocker is external.
- Keep final acceptance deterministic, but still put an agent repair step before commit/PR creation. If the repair budget is exhausted or a true external blocker remains, write a blocked artifact and skip commit/PR creation; do not let the workflow end as `FAILED`.
- Use `.reliable()` or `.repairable()` on SDK versions that support it, especially for product-contract workflows. As of AgentWorkforce/relay#827, retry-mode workflows with agents are repair-aware by default, repair agents run before retrying malformed/failed agent steps, and the SDK covers DAG, pipeline, fan-out, worktree-backed, deterministic-only, and agent-plus-gate shapes.

### Review-Depth Fresh-Eyes Loops

#### Review depth changes only the number of LLM fresh-eyes passes. It never removes deterministic proof, repairable validation, final hard validation, scoped diff evidence, blocked-state handling, or final signoff.

```text
verdict: FINDINGS | NO_ISSUES_FOUND | BLOCKED
finding_id: short stable id
severity: blocker | high | medium | low
file: path/to/file
issue: what is wrong
fix_required: concrete change needed
test_required: test, fixture, assertion, or proof command needed
status: open | fixed | wontfix | blocked
evidence: commands run, file paths, or blocker details
```


### Choose Your Coordination Style — Conversation vs Pipeline

Before writing the workflow, decide *how the agents will coordinate*. The relay primitive supports two very different shapes, and picking the wrong one wastes the most valuable thing the SDK gives you.

| Shape | What it is | Use when |
|---|---|---|
| **Conversation** (chat-native) | Interactive agents share a channel; messages, `@-mentions`, and ambient awareness drive coordination. Lead and workers spawn in parallel and self-organize. The relay is the coordination layer, not just transport. | Multi-file work, peer review loops, cross-agent feedback, dynamic re-planning, multi-PR coordination, anything with a human-in-the-loop escape, swarms where workers pick up each other's output. |
| **Pipeline** (one-shot DAG) | Each step runs as a one-shot subprocess (`claude -p`, `codex exec`); steps hand off via `{{steps.X.output}}` text injection. No agents are alive at the same time; no chat happens. | Linear, well-specified transformations; deterministic data passing; no live agent-to-agent coordination during implementation. The selected review-depth path and deterministic final gates still apply. |

**Default to Conversation for any non-trivial work.** Pipeline DAGs are simpler to reason about but they do not exercise the relay primitive — they are a Unix pipe with extra steps. If you would happily write the same task as a single shell pipeline, pipeline-shape is fine. Otherwise, you almost certainly want a Conversation shape.

The two shapes can mix within one workflow: pipeline-style deterministic preflight → conversation in the middle → pipeline-style commit-and-PR at the end. See **Quick Reference (Conversation)** below and **[Common Patterns → Interactive Team](#interactive-team-lead--workers-on-shared-channel)** for the canonical recipe.

> **A blunt rule of thumb:** if your workflow only uses `agent` steps with `preset: 'worker'` chained by `{{steps.X.output}}`, you are not using the relay — you are using `claude -p | codex exec`. That may still be the right answer; just make it a deliberate choice.

### Quick Reference (Pipeline shape)

#### > Use this when steps are linear, well-specified, and need no agent-to-agent feedback. For anything with iteration, review, or coordination, jump to **Quick Reference (Conversation shape)** below.

```typescript
import { workflow } from '@agent-relay/sdk/workflows';

async function runWorkflow() {
  const result = await workflow('my-workflow')
    .description('What this workflow does')
    .pattern('dag') // or 'pipeline', 'fan-out', etc.
    .channel('wf-my-workflow') // dedicated channel (auto-generated if omitted)
    .maxConcurrency(3)
    .timeout(3_600_000) // global timeout (ms)
    .repairable()

    .agent('lead', { cli: 'claude', role: 'Architect', retries: 2 })
    .agent('worker', { cli: 'codex', role: 'Implementer', retries: 2 })
    .agent('claude-reviewer', { cli: 'claude', role: 'First-pass fresh-eyes reviewer', retries: 1, preset: 'reviewer' })
    .agent('claude-fixer', { cli: 'claude', role: 'First-pass review-finding fixer', retries: 2 })
    .agent('codex-reviewer', { cli: 'codex', role: 'Second-pass fresh-eyes reviewer', retries: 1, preset: 'reviewer' })
    .agent('codex-fixer', { cli: 'codex', role: 'Review-finding fixer', retries: 2 })

    .step('preflight', {
      type: 'deterministic',
      command: 'git rev-parse --show-toplevel >/dev/null && echo PREFLIGHT_OK',
      captureOutput: true,
      failOnError: true,
    })
    .step('plan', {
      agent: 'lead',
      dependsOn: ['preflight'],
      task: `Analyze the codebase and produce a plan.`,
      retries: 2,
      verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
    })
    .step('implement', {
      agent: 'worker',
      task: `Implement based on this plan:\n{{steps.plan.output}}`,
      dependsOn: ['plan'],
      verification: { type: 'exit_code' },
    })
    .step('claude-review', {
      agent: 'claude-reviewer',
      dependsOn: ['implement'],
      task: `Fresh-eyes review the completed workflow output. Read the actual files, diff, repo rules, and available evidence.
Write findings to .workflow-artifacts/my-workflow/claude-review.md.
If there are no actionable issues, write NO_ISSUES_FOUND.`,
      verification: { type: 'exit_code' },
    })
    .step('claude-fix', {
      agent: 'claude-fixer',
      dependsOn: ['claude-review'],
      task: `Read .workflow-artifacts/my-workflow/claude-review.md.
Fix every valid issue, add or update appropriate tests/proofs for the fix, rerun relevant checks, and update .workflow-artifacts/my-workflow/claude-fix.md.
If the review says NO_ISSUES_FOUND, record that no fix was needed.`,
      verification: { type: 'exit_code' },
    })
    .step('claude-review-final', {
      agent: 'claude-reviewer',
      dependsOn: ['claude-fix'],
      task: `Fresh-eyes review the post-fix state from scratch. Do not rely on the prior review or fix summary.
Write .workflow-artifacts/my-workflow/claude-review-final.md with either actionable findings or NO_ISSUES_FOUND.`,
      verification: { type: 'exit_code' },
    })
    .step('claude-fix-final', {
      agent: 'claude-fixer',
      dependsOn: ['claude-review-final'],
      task: `If .workflow-artifacts/my-workflow/claude-review-final.md contains findings, fix them, add or update appropriate tests/proofs, and rerun relevant checks.
If no fix is possible, write .workflow-artifacts/my-workflow/BLOCKED_NO_COMMIT.md with exact evidence.
If it says NO_ISSUES_FOUND, record Claude review signoff.`,
      verification: { type: 'exit_code' },
    })
    .step('codex-review', {
      agent: 'codex-reviewer',
      dependsOn: ['claude-fix-final'],
      task: `Second-pass fresh-eyes review of the post-Claude-fix state. Read the actual files, diff, repo rules, and available evidence.
Write findings to .workflow-artifacts/my-workflow/codex-review.md.
If there are no actionable issues, write NO_ISSUES_FOUND.`,
      verification: { type: 'exit_code' },
    })
    .step('codex-fix', {
      agent: 'codex-fixer',
      dependsOn: ['codex-review'],
      task: `Read .workflow-artifacts/my-workflow/codex-review.md.
Fix every valid issue, add or update appropriate tests/proofs for the fix, rerun relevant checks, and update .workflow-artifacts/my-workflow/codex-fix.md.
If the review says NO_ISSUES_FOUND, record that no fix was needed.`,
      verification: { type: 'exit_code' },
    })
    .step('codex-review-final', {
      agent: 'codex-reviewer',
      dependsOn: ['codex-fix'],
      task: `Fresh-eyes review the post-Codex-fix state from scratch. Do not rely on the prior review or fix summary.
Write .workflow-artifacts/my-workflow/codex-review-final.md with either actionable findings or NO_ISSUES_FOUND.`,
      verification: { type: 'exit_code' },
    })
    .step('codex-fix-final', {
      agent: 'codex-fixer',
      dependsOn: ['codex-review-final'],
      task: `If .workflow-artifacts/my-workflow/codex-review-final.md contains findings, fix them, add or update appropriate tests/proofs, and rerun relevant checks.
If no fix is possible, write .workflow-artifacts/my-workflow/BLOCKED_NO_COMMIT.md with exact evidence.
If it says NO_ISSUES_FOUND, record final review signoff.`,
      verification: { type: 'exit_code' },
    })
    .step('acceptance-after-review', {
      type: 'deterministic',
      dependsOn: ['codex-fix-final'],
      command: 'test ! -f .workflow-artifacts/my-workflow/BLOCKED_NO_COMMIT.md && echo ACCEPTANCE_OK',
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
```


### Quick Reference (Conversation shape)

#### > Use this for any non-trivial work — peer review, multi-file edits, cross-agent feedback, dynamic re-planning. Lead and workers spawn **in parallel** on a shared channel and self-organize via messages. The relay primitive does the coordinating; verification gates downstream of the lead close the workflow.

```typescript
import { workflow } from '@agent-relay/sdk/workflows';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

async function runWorkflow() {
  const result = await workflow('my-workflow')
  .description('Multi-file change with peer review')
  .pattern('dag')
  .channel('wf-my-feature')          // dedicated channel — agents share it
  .maxConcurrency(4)
  .timeout(3_600_000)
  .repairable()

  // Interactive agents — no preset, they live on the channel
  .agent('lead', {
    cli: 'claude',
    model: ClaudeModels.OPUS,
    role: 'Architect + reviewer. Plans, assigns, reviews, posts feedback.',
    retries: 1,
  })
  .agent('impl-a', {
    cli: 'codex',
    model: CodexModels.GPT_5_4,
    role: 'Implementer. Listens on channel for assignments and feedback.',
    retries: 2,
  })
  .agent('impl-b', {
    cli: 'codex',
    model: CodexModels.GPT_5_4,
    role: 'Implementer. Listens on channel for assignments and feedback.',
    retries: 2,
  })
  .agent('claude-reviewer', {
    cli: 'claude',
    model: ClaudeModels.OPUS,
    preset: 'reviewer',
    role: 'First-pass fresh-eyes reviewer. Reads the final diff and artifacts from scratch.',
    retries: 1,
  })
  .agent('claude-fixer', {
    cli: 'claude',
    model: ClaudeModels.SONNET,
    role: 'First-pass review-finding fixer. Repairs valid findings, adds tests/proofs, and reruns checks.',
    retries: 2,
  })
  .agent('codex-reviewer', {
    cli: 'codex',
    model: CodexModels.GPT_5_4,
    preset: 'reviewer',
    role: 'Second-pass fresh-eyes reviewer. Reviews the post-Claude-fix state from scratch.',
    retries: 1,
  })
  .agent('codex-fixer', {
    cli: 'codex',
    model: CodexModels.GPT_5_4,
    role: 'Review-finding fixer. Repairs valid findings, adds tests/proofs, and reruns checks.',
    retries: 2,
  })

  // Deterministic context — pre-reads files once, posts to the channel for everyone
  .step('preflight', {
    type: 'deterministic',
    command: 'git rev-parse --show-toplevel >/dev/null && echo PREFLIGHT_OK',
    captureOutput: true,
    failOnError: true,
  })
  .step('context', {
    type: 'deterministic',
    dependsOn: ['preflight'],
    command: 'git ls-files src/',
    captureOutput: true,
  })

  // Lead and workers all depend on `context` — they start CONCURRENTLY.
  // They coordinate over #wf-my-feature, not via {{steps.X.output}}.
  .step('lead-coordinate', {
    agent: 'lead',
    dependsOn: ['context'],
    task: `You are the lead on #wf-my-feature. Workers: impl-a, impl-b.
Post the plan. Assign files. Review their PRs/diffs. Post feedback in-channel.
Workers iterate based on your feedback. Exit when both files pass review.`,
  })
  .step('impl-a-work', {
    agent: 'impl-a',
    dependsOn: ['context'],   // SAME dep as lead → starts in parallel, no deadlock
    task: `You are impl-a on #wf-my-feature. Wait for the lead's plan.
Implement your assigned file. Post a completion message. Address feedback.`,
  })
  .step('impl-b-work', {
    agent: 'impl-b',
    dependsOn: ['context'],   // SAME dep as lead
    task: `You are impl-b on #wf-my-feature. Wait for the lead's plan.
Implement your assigned file. Post a completion message. Address feedback.`,
  })

  // Downstream gates on the lead — lead exits when satisfied.
  // Capture failures, then hand them to an agent for repair.
  .step('verify', {
    type: 'deterministic',
    dependsOn: ['lead-coordinate'],
    command: 'npm run typecheck && npm test 2>&1',
    captureOutput: true,
    failOnError: false,
  })
  .step('repair-verify', {
    agent: 'lead',
    dependsOn: ['verify'],
    task: `If verification passed, summarize evidence.
If it failed, use this output to assign and fix issues, then rerun the command until green:
{{steps.verify.output}}`,
    verification: { type: 'exit_code' },
  })
  .step('verify-final', {
    type: 'deterministic',
    dependsOn: ['repair-verify'],
    command: 'npm run typecheck && npm test 2>&1',
    captureOutput: true,
    failOnError: false,
  })
  .step('claude-review', {
    agent: 'claude-reviewer',
    dependsOn: ['verify-final'],
    task: `First-pass fresh-eyes review of the post-implementation state.
Read the actual changed files, git diff, repo instructions, task spec, and verification output:
{{steps.verify-final.output}}

Write .workflow-artifacts/my-feature/claude-review.md with:
- actionable findings, each with file paths and required fix
- or NO_ISSUES_FOUND if there are no remaining issues`,
    verification: { type: 'exit_code' },
  })
  .step('claude-fix', {
    agent: 'claude-fixer',
    dependsOn: ['claude-review'],
    task: `Read .workflow-artifacts/my-feature/claude-review.md.
If there are findings, fix every valid one and add or update appropriate tests/proofs. After each fix, rerun the relevant check and review the changed files again.
Keep iterating locally until this round has no remaining valid issues.
Write .workflow-artifacts/my-feature/claude-fix.md with fixes and commands run.
If the review says NO_ISSUES_FOUND, write that no fix was needed.`,
    verification: { type: 'exit_code' },
  })
  .step('claude-review-final', {
    agent: 'claude-reviewer',
    dependsOn: ['claude-fix'],
    task: `Perform a fresh post-fix review from scratch. Do not rely on previous review text or the fixer's summary.
Read files, diff, repo rules, task spec, and evidence. Write .workflow-artifacts/my-feature/claude-review-final.md.
Use NO_ISSUES_FOUND only if there are no actionable issues left.`,
    verification: { type: 'exit_code' },
  })
  .step('claude-fix-final', {
    agent: 'claude-fixer',
    dependsOn: ['claude-review-final'],
    task: `If the final Claude review found issues, fix them, add or update appropriate tests/proofs, and rerun the relevant checks until green.
If no fix is possible, write .workflow-artifacts/my-feature/BLOCKED_NO_COMMIT.md with exact evidence and do not commit.
If the final review says NO_ISSUES_FOUND, record signoff in .workflow-artifacts/my-feature/claude-signoff.md.`,
    verification: { type: 'exit_code' },
  })
  .step('verify-after-claude-review', {
    type: 'deterministic',
    dependsOn: ['claude-fix-final'],
    command: 'test ! -f .workflow-artifacts/my-feature/BLOCKED_NO_COMMIT.md && npm run typecheck && npm test 2>&1',
    captureOutput: true,
    failOnError: false,
  })
  .step('codex-review', {
    agent: 'codex-reviewer',
    dependsOn: ['verify-after-claude-review'],
    task: `Second-pass fresh-eyes review of the post-Claude-fix state.
Read the actual changed files, git diff, repo instructions, task spec, and verification output:
{{steps.verify-after-claude-review.output}}

Write .workflow-artifacts/my-feature/codex-review.md with:
- actionable findings, each with file paths and required fix
- or NO_ISSUES_FOUND if there are no remaining issues`,
    verification: { type: 'exit_code' },
  })
  .step('codex-fix', {
    agent: 'codex-fixer',
    dependsOn: ['codex-review'],
    task: `Read .workflow-artifacts/my-feature/codex-review.md.
If there are findings, fix every valid one and add or update appropriate tests/proofs. After each fix, rerun the relevant check and review the changed files again.
Keep iterating locally until this round has no remaining valid issues.
Write .workflow-artifacts/my-feature/codex-fix.md with fixes and commands run.
If the review says NO_ISSUES_FOUND, write that no fix was needed.`,
    verification: { type: 'exit_code' },
  })
  .step('codex-review-final', {
    agent: 'codex-reviewer',
    dependsOn: ['codex-fix'],
    task: `Perform a fresh post-Codex-fix review from scratch. Do not rely on previous review text or the fixer's summary.
Read files, diff, repo rules, task spec, and evidence. Write .workflow-artifacts/my-feature/codex-review-final.md.
Use NO_ISSUES_FOUND only if there are no actionable issues left.`,
    verification: { type: 'exit_code' },
  })
  .step('codex-fix-final', {
    agent: 'codex-fixer',
    dependsOn: ['codex-review-final'],
    task: `If the final Codex review found issues, fix them, add or update appropriate tests/proofs, and rerun the relevant checks until green.
If no fix is possible, write .workflow-artifacts/my-feature/BLOCKED_NO_COMMIT.md with exact evidence and do not commit.
If the final review says NO_ISSUES_FOUND, record signoff in .workflow-artifacts/my-feature/codex-signoff.md.`,
    verification: { type: 'exit_code' },
  })
  .step('verify-after-review', {
    type: 'deterministic',
    dependsOn: ['codex-fix-final'],
    command: 'test ! -f .workflow-artifacts/my-feature/BLOCKED_NO_COMMIT.md && npm run typecheck && npm test 2>&1',
    captureOutput: true,
    failOnError: true,
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
```


### Default For Serious Implementation: Shadowed Squad Review Loop

- implementer: owns a tight file/subsystem scope and writes the change
- shadow reviewer: follows the implementer in real time, checks drift against the spec, and leaves feedback early
- optional validation owner: owns tests, dry-run proof, or fixture coverage when that is a separate deliverable
- Deterministically read the spec, AGENTS.md / CLAUDE.md, workflow standards, recent local docs, and declared file targets.
- Lead splits work into bounded squads with non-overlapping ownership.
- Squads run in parallel. The shadow reads actual files and channel updates, then posts feedback while the implementer is still active.
- Each implementer writes a self-reflection artifact before external review. It must answer: what changed, what spec items are satisfied, what tests/proofs ran, what risks remain, and how the work follows repo rules.
- A fresh self-review agent reads the post-implementation files, recent local conventions, AGENTS.md / CLAUDE.md, and related rules. It should not rely on the implementer's summary.
- The implementer gets that feedback and performs a repair pass.
- Deterministic gates run with captured output. Red output goes to a repair owner, then the same gate reruns.
- Run the selected review-depth fresh-eyes loop exactly: light ends after `fix-loop` and `post-fix-validation`; standard adds `final-review-claude` and `final-fix-claude`; deep adds the full Codex loop after the Claude final fix.
- Optional extra reviewers can be added for high-stakes work, but they do not replace the selected review-depth loop.
- Final signoff only happens after the selected post-fix review path and final deterministic gates prove the spec is complete, or a blocker artifact explains why it cannot be completed.
- Critical TypeScript rules:
- Check the project's `package.json` for `"type": "module"` — if ESM, use `import`; if CJS, use `require()`. In both cases, wrap execution in an async function instead of raw top-level `await`.
- `agent-relay run <file.ts>` executes the file as a standalone subprocess — it does NOT inspect exports. The file MUST call `.run()`.
- Use `.run({ cwd: process.cwd() })` — `createWorkflowRenderer` does not exist
- Validate with `--dry-run` before running: `agent-relay run --dry-run workflow.ts`

### ⚡ Parallelism — Design for Speed

#### Cross-Workflow Parallelism: Wave Planning

```bash
# BAD — sequential (14 hours for 27 workflows at ~30 min each)
agent-relay run workflows/34-sst-wiring.ts
agent-relay run workflows/35-env-config.ts
agent-relay run workflows/36-loading-states.ts
# ... one at a time

# GOOD — parallel waves (3-4 hours for 27 workflows)
# Wave 1: independent infra (parallel)
agent-relay run workflows/34-sst-wiring.ts &
agent-relay run workflows/35-env-config.ts &
agent-relay run workflows/36-loading-states.ts &
agent-relay run workflows/37-responsive.ts &
wait
git add -A && git commit -m "Wave 1"

# Wave 2: testing (parallel — independent test suites)
agent-relay run workflows/40-unit-tests.ts &
agent-relay run workflows/41-integration-tests.ts &
agent-relay run workflows/42-e2e-tests.ts &
wait
git add -A && git commit -m "Wave 2"
```

#### Declare File Scope for Planning

```typescript
workflow('48-comparison-mode')
  .packages(['web', 'core'])                // monorepo packages touched
  .isolatedFrom(['49-feedback-system'])      // explicitly safe to parallelize
  .requiresBefore(['46-admin-dashboard'])    // explicit ordering constraint
```

#### Within-Workflow Parallelism

```typescript
// BAD — unnecessary sequential chain
.step('fix-component-a', { agent: 'worker', dependsOn: ['review'] })
.step('fix-component-b', { agent: 'worker', dependsOn: ['fix-component-a'] })  // why wait?

// GOOD — parallel fan-out, merge at the end
.step('fix-component-a', { agent: 'impl-1', dependsOn: ['review'] })
.step('fix-component-b', { agent: 'impl-2', dependsOn: ['review'] })  // same dep = parallel
.step('verify-all', { agent: 'reviewer', dependsOn: ['fix-component-a', 'fix-component-b'] })
```


### Failure Prevention

#### 1. Do not use raw top-level `await`

```ts
async function runWorkflow() {
  const result = await workflow('my-workflow')
    // ...
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

#### 2b. Standard preflight template for resumable workflows

```ts
.step('preflight', {
  type: 'deterministic',
  command: [
    'set -e',
    'BRANCH=$(git rev-parse --abbrev-ref HEAD)',
    'echo "branch: $BRANCH"',
    'if [ "$BRANCH" != "fix/your-branch-name" ]; then echo "ERROR: wrong branch"; exit 1; fi',
    // Files the workflow is allowed to find dirty on entry:
    //   - package-lock.json: npm install is idempotent and often touches it
    //   - every file the workflow's edit steps will rewrite: a prior partial
    //     run may have left them dirty, and the edit step will rewrite
    //     them cleanly before commit
    // Everything else is unexpected drift and must fail preflight.
    'ALLOWED_DIRTY="package-lock.json|path/to/file1\\\\.ts|path/to/file2\\\\.ts"',
    'DIRTY=$(git diff --name-only | grep -vE "^(${ALLOWED_DIRTY})$" || true)',
    'if [ -n "$DIRTY" ]; then echo "ERROR: unexpected tracked drift:"; echo "$DIRTY"; exit 1; fi',
    'if ! git diff --cached --quiet; then echo "ERROR: staging area is dirty"; git diff --cached --stat; exit 1; fi',
    'gh auth status >/dev/null 2>&1 || (echo "ERROR: gh CLI not authenticated"; exit 1)',
    'echo PREFLIGHT_OK',
  ].join(' && '),
  captureOutput: true,
  failOnError: true,
}),
```

#### 2c. Picking the right `.join()` for multi-line shell commands

```ts
command: [
  'set -e',
  'HITS=$(grep -c diag src/cli/commands/setup.ts || true)',
  'if [ "$HITS" -lt 6 ]; then echo "FAIL"; exit 1; fi',
  'echo OK',
].join(' && '),
```

#### 3. Keep final verification boring and deterministic

```bash
grep -Eq "foo|bar|baz" file.ts
```

#### 6. Be explicit about shell requirements

```bash
/opt/homebrew/bin/bash workflows/your-workflow/execute.sh --wave 2
```

#### 9. Factor repo-specific setup into a shared helper

```ts
// workflows/lib/cloud-repo-setup.ts
export interface CloudRepoSetupOptions {
  branch: string;
  committerName?: string;
  extraSetupCommands?: string[];
  skipWorkspaceBuild?: boolean;
}

export function applyCloudRepoSetup<T>(wf: T, opts: CloudRepoSetupOptions): T {
  // adds two steps: setup-branch, install-deps
  // install-deps runs: npm install + workspace prebuilds (build:platform, build:core, etc.)
  // ...
}
```


### End-to-End Bug Fix Workflows

- **Capture the original failure**
- Reproduce the bug first in a deterministic or evidence-capturing step
- Save exact commands, logs, status codes, or screenshots/artifacts
- **State the acceptance contract**
- Define the exact end-to-end success criteria before implementation
- Include the real entrypoint a user would run
- **Implement the fix**
- **Rebuild / reinstall from scratch**
- Do not trust dirty local state
- Prefer a clean environment when install/bootstrap behavior is involved
- **Run targeted regression checks**
- Unit/integration tests are helpful but not sufficient by themselves
- **Run a full end-to-end validation**
- Use the real CLI / API / install path
- Prefer a clean environment (Docker, sandbox, cloud workspace, Daytona, etc.) for install/runtime issues
- **Compare before vs after evidence**
- Show that the original failure no longer occurs
- **Record residual risks**
- Call out what was not covered
- **Ship the result as a PR**
- Open the pull request from the workflow itself with `createGitHubStep` from `@agent-relay/sdk` — **never** `gh pr create`, never omit `name`, never put action inputs like `branch` at the top level instead of `params`, never use `id:` inside the config, never use `command:` inside the config, never use `action: 'createPullRequest'`, never separate `owner`/`repo` fields
- See [Shipping the Result — Open a PR via `createGitHubStep`](#shipping-the-result--open-a-pr-via-creategithubstep) below
- A workflow that fixes a bug and stops short of the PR has only done half the loop
- disposable sandbox / cloud workspace
- Docker / containerized environment
- fresh local shell with isolated paths
- compares candidate validation environments
- defines the acceptance contract
- chooses the best swarm pattern
- then authors the final fix/validation workflow

### Shipping the Result — Open a PR via `createGitHubStep`

#### The minimal "open a PR" recipe

```typescript
import { workflow } from '@agent-relay/sdk/workflows';
import { createGitHubStep } from '@agent-relay/sdk';

const REPO = 'AgentWorkforce/cloud';
const BRANCH = `agent-relay/run-${Date.now()}`;

async function runWorkflow() {
  await workflow('feature-x')
    // ... your real implementation, repair, review loops, and final acceptance ...
    .step('write-marker', {
      type: 'deterministic',
      command: `echo "fix landed at $(date -u)" >> CHANGELOG.md`,
    })

    // Branch off main on the remote.
    .step('create-branch', createGitHubStep({
      name: 'create-branch',
      dependsOn: ['write-marker'],
      action: 'createBranch',
      repo: REPO,
      params: { branch: BRANCH, fromBranch: 'main' },
    }))

    // Commit the change to the branch via Contents API.
    .step('commit-change', createGitHubStep({
      name: 'commit-change',
      dependsOn: ['create-branch'],
      action: 'createFile',
      repo: REPO,
      params: {
        path: 'CHANGELOG.md',
        branch: BRANCH,
        content: '<file body here>',
        message: 'chore: changelog entry',
      },
    }))

    // Open the PR. This is the load-bearing step.
    .step('open-pr', createGitHubStep({
      name: 'open-pr',
      dependsOn: ['commit-change'],
      action: 'createPR',
      repo: REPO,
      params: {
        title: 'feat: ship feature X',
        head: BRANCH,
        base: 'main',
        body: '## Summary\n\n- ...\n\n## Test plan\n\n- [x] ...',
        draft: false,
      },
      output: { mode: 'data', format: 'json', path: 'html_url' },
    }))

    .run({ cwd: process.cwd() });
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

`createGitHubStep` validates its config before the workflow starts. The config object must include a non-empty `name` field and a valid `action` such as `createPR`; the outer `.step('open-pr', ...)` name alone is not enough. Do not pass deterministic shell-step fields such as `command` to `createGitHubStep`.


### Key Concepts

#### Verification Gates

```typescript
verification: { type: 'exit_code' }                        // preferred for code-editing steps
verification: { type: 'output_contains', value: 'DONE' }   // optional accelerator
verification: { type: 'file_exists', value: 'src/out.ts' } // deterministic file check
verification: { type: 'pr_url', value: 'owner/repo' }      // step must leave behind a PR
```

#### DAG Dependencies

```typescript
.step('fix-types',  { agent: 'worker', dependsOn: ['review'], ... })
.step('fix-tests',  { agent: 'worker', dependsOn: ['review'], ... })
.step('final',      { agent: 'lead',   dependsOn: ['fix-types', 'fix-tests'], ... })
```

#### SDK API

```typescript
// Subscribe an agent to additional channels post-spawn
relay.subscribe({ agent: 'security-auditor', channels: ['review-pr-456'] });

// Unsubscribe — agent leaves the channel entirely
relay.unsubscribe({ agent: 'security-auditor', channels: ['general'] });

// Mute — agent stays subscribed (history access) but messages are NOT injected into PTY
relay.mute({ agent: 'security-auditor', channel: 'review-pr-123' });

// Unmute — resume PTY injection
relay.unmute({ agent: 'security-auditor', channel: 'review-pr-123' });
```

#### Events

```typescript
relay.onChannelSubscribed = (agent, channels) => { /* ... */ };
relay.onChannelUnsubscribed = (agent, channels) => { /* ... */ };
relay.onChannelMuted = (agent, channel) => { /* ... */ };
relay.onChannelUnmuted = (agent, channel) => { /* ... */ };
```


### Agent Definition

#### ```typescript

```typescript
.agent('name', {
  cli: 'claude' | 'codex' | 'gemini' | 'aider' | 'goose' | 'opencode' | 'droid',
  role?: string,
  preset?: 'lead' | 'worker' | 'reviewer' | 'analyst',
  retries?: number,
  model?: string,
  interactive?: boolean, // default: true
})
```

#### Model Constants

```typescript
import { ClaudeModels, CodexModels, GeminiModels } from '@agent-relay/config';

.agent('planner', { cli: 'claude', model: ClaudeModels.OPUS })    // not 'opus'
.agent('worker',  { cli: 'claude', model: ClaudeModels.SONNET })  // not 'sonnet'
.agent('coder',   { cli: 'codex',  model: CodexModels.GPT_5_4 })  // not 'gpt-5.4'
```


### Step Definition

#### Agent Steps

```typescript
.step('name', {
  agent: string,
  task: string,                   // supports {{var}} and {{steps.NAME.output}}
  dependsOn?: string[],
  verification?: VerificationCheck,
  retries?: number,
})
```

#### Deterministic Steps (Shell Commands)

```typescript
.step('verify-files', {
  type: 'deterministic',
  command: 'test -f src/auth.ts && echo "FILE_EXISTS"',
  dependsOn: ['implement'],
  captureOutput: true,
  failOnError: false,
})
.step('repair-files', {
  agent: 'worker',
  dependsOn: ['verify-files'],
  task: `If verify-files failed, create or fix the missing file and rerun the check.
Output:
{{steps.verify-files.output}}`,
  verification: { type: 'exit_code' },
})
.step('verify-files-final', {
  type: 'deterministic',
  command: 'test -f src/auth.ts && echo "FILE_EXISTS"',
  dependsOn: ['repair-files'],
  captureOutput: true,
  failOnError: true,
})
```


### Common Patterns

#### Deep-Tier Claude-Then-Codex Review/Fix Loops

```typescript
.agent('claude-reviewer', {
  cli: 'claude',
  preset: 'reviewer',
  role: 'First-pass fresh-eyes reviewer. Reads actual files, diffs, rules, and evidence from scratch.',
  retries: 1,
})
.agent('claude-fixer', {
  cli: 'claude',
  role: 'Fixer for valid Claude review findings. Adds or updates tests/proofs for each fix.',
  retries: 2,
})
.agent('codex-reviewer', {
  cli: 'codex',
  preset: 'reviewer',
  role: 'Second-pass fresh-eyes reviewer. Reviews the post-Claude-fix state from scratch.',
  retries: 1,
})
.agent('codex-fixer', {
  cli: 'codex',
  role: 'Fixer for valid Codex review findings. Adds or updates tests/proofs for each fix.',
  retries: 2,
})

.step('claude-review', {
  agent: 'claude-reviewer',
  dependsOn: ['verify-final'],
  task: `First-pass fresh-eyes review.
Read the task spec, AGENTS.md / CLAUDE.md, changed files, final diff, artifacts, and verification evidence:
{{steps.verify-final.output}}

Write .workflow-artifacts/<workflow>/claude-review.md.
Use actionable findings with file paths, severity, and required fixes.
If there are no issues, write NO_ISSUES_FOUND.`,
  verification: { type: 'exit_code' },
})
.step('claude-fix', {
  agent: 'claude-fixer',
  dependsOn: ['claude-review'],
  task: `Read .workflow-artifacts/<workflow>/claude-review.md.
If it contains findings, fix every valid issue and add or update appropriate tests/proofs. After each fix, rerun targeted checks and review the touched files again.
Keep iterating locally until this round has no remaining valid issues.
Write .workflow-artifacts/<workflow>/claude-fix.md with fixes and commands run.
If the review says NO_ISSUES_FOUND, record that no fix was needed.`,
  verification: { type: 'exit_code' },
})
.step('claude-review-final', {
  agent: 'claude-reviewer',
  dependsOn: ['claude-fix'],
  task: `Review the post-Claude-fix state from scratch. Do not rely on prior review text or fixer summaries.
Read the files, diff, rules, spec, and evidence. Write .workflow-artifacts/<workflow>/claude-review-final.md.
Use NO_ISSUES_FOUND only if there are no actionable issues left.`,
  verification: { type: 'exit_code' },
})
.step('claude-fix-final', {
  agent: 'claude-fixer',
  dependsOn: ['claude-review-final'],
  task: `If the final Claude review contains findings, fix them, add or update appropriate tests/proofs, rerun relevant checks, and write .workflow-artifacts/<workflow>/claude-fix-final.md.
If a finding cannot be fixed, write .workflow-artifacts/<workflow>/BLOCKED_NO_COMMIT.md with exact evidence.
If the final review says NO_ISSUES_FOUND, write .workflow-artifacts/<workflow>/claude-signoff.md.`,
  verification: { type: 'exit_code' },
})
.step('verify-after-claude-review', {
  type: 'deterministic',
  dependsOn: ['claude-fix-final'],
  command: 'test ! -f .workflow-artifacts/<workflow>/BLOCKED_NO_COMMIT.md && npm run typecheck && npm test 2>&1',
  captureOutput: true,
  failOnError: false,
})
.step('codex-review', {
  agent: 'codex-reviewer',
  dependsOn: ['verify-after-claude-review'],
  task: `Second-pass fresh-eyes review of the post-Claude-fix state.
Read the task spec, AGENTS.md / CLAUDE.md, changed files, final diff, artifacts, and verification evidence:
{{steps.verify-after-claude-review.output}}

Write .workflow-artifacts/<workflow>/codex-review.md.
Use actionable findings with file paths, severity, and required fixes.
If there are no issues, write NO_ISSUES_FOUND.`,
  verification: { type: 'exit_code' },
})
.step('codex-fix', {
  agent: 'codex-fixer',
  dependsOn: ['codex-review'],
  task: `Read .workflow-artifacts/<workflow>/codex-review.md.
If it contains findings, fix every valid issue and add or update appropriate tests/proofs. After each fix, rerun targeted checks and review the touched files again.
Keep iterating locally until this round has no remaining valid issues.
Write .workflow-artifacts/<workflow>/codex-fix.md with fixes and commands run.
If the review says NO_ISSUES_FOUND, record that no fix was needed.`,
  verification: { type: 'exit_code' },
})
.step('codex-review-final', {
  agent: 'codex-reviewer',
  dependsOn: ['codex-fix'],
  task: `Review the post-fix state from scratch. Do not rely on prior review text or fixer summaries.
Read the files, diff, rules, spec, and evidence. Write .workflow-artifacts/<workflow>/codex-review-final.md.
Use NO_ISSUES_FOUND only if there are no actionable issues left.`,
  verification: { type: 'exit_code' },
})
.step('codex-fix-final', {
  agent: 'codex-fixer',
  dependsOn: ['codex-review-final'],
  task: `If the final review contains findings, fix them, add or update appropriate tests/proofs, rerun relevant checks, and write .workflow-artifacts/<workflow>/codex-fix-final.md.
If a finding cannot be fixed, write .workflow-artifacts/<workflow>/BLOCKED_NO_COMMIT.md with exact evidence.
If the final review says NO_ISSUES_FOUND, write .workflow-artifacts/<workflow>/codex-signoff.md.`,
  verification: { type: 'exit_code' },
})
.step('acceptance-after-codex-review', {
  type: 'deterministic',
  dependsOn: ['codex-fix-final'],
  command: 'test ! -f .workflow-artifacts/<workflow>/BLOCKED_NO_COMMIT.md && npm run typecheck && npm test 2>&1',
  captureOutput: true,
  failOnError: true,
})
```

#### Interactive Team (lead + workers on shared channel)

```typescript
.agent('lead', {
  cli: 'claude',
  model: ClaudeModels.OPUS,
  role: 'Architect and reviewer — assigns work, reviews, posts feedback',
  retries: 1,
  // No preset — interactive by default
})

.agent('impl-new', {
  cli: 'codex',
  model: CodexModels.GPT_5_4,
  role: 'Creates new files. Listens on channel for assignments and feedback.',
  retries: 2,
  // No preset — interactive, receives channel messages
})

.agent('impl-modify', {
  cli: 'codex',
  model: CodexModels.GPT_5_4,
  role: 'Edits existing files. Listens on channel for assignments and feedback.',
  retries: 2,
})

// All three share the same dependsOn — they start concurrently (no deadlock)
.step('lead-coordinate', {
  agent: 'lead',
  dependsOn: ['context'],
  task: `You are the lead on #channel. Workers: impl-new, impl-modify.
Post the plan. Assign files. Review their work. Post feedback if needed.
Workers iterate based on your feedback. Exit when all files are correct.`,
})
.step('impl-new-work', {
  agent: 'impl-new',
  dependsOn: ['context'],   // same dep as lead = parallel start
  task: `You are impl-new on #channel. Wait for the lead's plan.
Create files as assigned. Report completion. Fix issues from feedback.`,
})
.step('impl-modify-work', {
  agent: 'impl-modify',
  dependsOn: ['context'],   // same dep as lead = parallel start
  task: `You are impl-modify on #channel. Wait for the lead's plan.
Edit files as assigned. Report completion. Fix issues from feedback.`,
})
// Downstream gates on lead (lead exits when satisfied)
.step('verify', { type: 'deterministic', dependsOn: ['lead-coordinate'], ... })
```

#### 1. Question / Answer (blocking ask)

```typescript
.step('integrate', {
  agent: 'integrator',
  dependsOn: ['context'],
  task: `You are the integrator on #wf-feature.
Before writing code, post a direct question to @schema-owner asking which
table owns the new field. Do NOT proceed until @schema-owner replies in
channel. If no reply arrives in 5 minutes, @-mention the lead.`,
})
```

#### 2. Broadcast / Ack

```typescript
.step('lead-coordinate', {
  agent: 'lead',
  dependsOn: ['context'],
  task: `Post the plan to #wf-feature, then @impl-a @impl-b @impl-c.
Wait for each to reply with "ACK <agent-name>" before issuing assignments.
If any worker hasn't acked in 3 minutes, re-post and ping again.
Only after all three have acked, post per-worker assignments.`,
})
```

#### 3. Peer Review Handoff

```typescript
.step('impl-a-work', {
  agent: 'impl-a',
  dependsOn: ['context'],
  task: `Implement src/foo.ts per the lead's assignment.
When done, post to #wf-feature: "@reviewer ready: src/foo.ts" — include the
commit SHA. Then wait for @reviewer's verdict in channel.
- If "APPROVED", you're done.
- If "CHANGES_REQUESTED <notes>", apply the notes and re-post.
- If no verdict in 5 min, @-mention the lead.`,
})
```

#### 4. Standup / Status Probe

```typescript
.step('lead-coordinate', {
  agent: 'lead',
  task: `... coordinate the team ...

Every 10 minutes, post a status probe: "@impl-a @impl-b status?"
Each worker should reply with one of:
  - "RUNNING <step>" (still working)
  - "BLOCKED <reason>" (@-mention the lead with the blocker)
  - "DONE <artifact>" (ready for review)

If a worker is silent for two probes in a row, mark them stalled and
reassign their work to a peer.`,
})
```

#### 5. Hand-Off with Context

```typescript
.step('impl-a-work', {
  agent: 'impl-a',
  task: `... finish your part ...

When done, post a handoff to #wf-feature targeting the next worker:
"@impl-b HANDOFF: src/foo.ts ready. Touched: <files>. Open question: <if any>.
Tests: <pass/fail summary>. Commit: <sha>."`,
})
```

#### Pipeline (sequential handoff)

```typescript
.pattern('pipeline')
.step('analyze', { agent: 'analyst', task: '...' })
.step('implement', { agent: 'dev', task: '{{steps.analyze.output}}', dependsOn: ['analyze'] })
.step('test', { agent: 'tester', task: '{{steps.implement.output}}', dependsOn: ['implement'] })
```

#### Error Handling

```typescript
.onError('fail-fast')   // stop on first failure (default)
.onError('continue')    // skip failed branches, continue others
.onError('retry', { maxRetries: 3, retryDelayMs: 5000 })
```


### Multi-File Edit Pattern

#### When a workflow needs to modify multiple existing files, **use one agent step per file** with a deterministic verify gate after each. Agents reliably edit 1-2 files per step but fail on 4+.

```yaml
steps:
  - name: read-types
    type: deterministic
    command: cat src/types.ts
    captureOutput: true

  - name: edit-types
    agent: dev
    dependsOn: [read-types]
    task: |
      Edit src/types.ts. Current contents:
      {{steps.read-types.output}}
      Add 'pending' to the Status union type.
      Only edit this one file.
    verification:
      type: exit_code

  - name: verify-types
    type: deterministic
    dependsOn: [edit-types]
    command: 'if git diff --quiet src/types.ts; then echo "NOT MODIFIED"; exit 1; fi; echo "OK"'
    captureOutput: true
    failOnError: false

  - name: fix-types-verification
    agent: dev
    dependsOn: [verify-types]
    task: |
      If verify-types failed, fix src/types.ts and rerun the verify command.
      Output:
      {{steps.verify-types.output}}
    verification:
      type: exit_code

  - name: verify-types-final
    type: deterministic
    dependsOn: [fix-types-verification]
    command: 'if git diff --quiet src/types.ts; then echo "NOT MODIFIED"; exit 1; fi; echo "OK"'
    captureOutput: true
    failOnError: true

  - name: read-service
    type: deterministic
    dependsOn: [verify-types-final]
    command: cat src/service.ts
    captureOutput: true

  - name: edit-service
    agent: dev
    dependsOn: [read-service]
    task: |
      Edit src/service.ts. Current contents:
      {{steps.read-service.output}}
      Add a handlePending() method.
      Only edit this one file.
    verification:
      type: exit_code

  - name: verify-service
    type: deterministic
    dependsOn: [edit-service]
    command: 'if git diff --quiet src/service.ts; then echo "NOT MODIFIED"; exit 1; fi; echo "OK"'
    captureOutput: true
    failOnError: false

  - name: fix-service-verification
    agent: dev
    dependsOn: [verify-service]
    task: |
      If verify-service failed, fix src/service.ts and rerun the verify command.
      Output:
      {{steps.verify-service.output}}
    verification:
      type: exit_code

  - name: verify-service-final
    type: deterministic
    dependsOn: [fix-service-verification]
    command: 'if git diff --quiet src/service.ts; then echo "NOT MODIFIED"; exit 1; fi; echo "OK"'
    captureOutput: true
    failOnError: true

  # Deterministic commit — never rely on agents to commit
  - name: commit
    type: deterministic
    dependsOn: [verify-service-final]
    command: npm run typecheck && npm test && git add src/types.ts src/service.ts && git commit -m "feat: add pending status"
    captureOutput: true
    failOnError: false

  - name: repair-commit
    agent: dev
    dependsOn: [commit]
    task: |
      If commit failed, fix the blocker, rerun npm run typecheck && npm test, and create the commit.
      If commit passed, confirm the commit subject.
      Output:
      {{steps.commit.output}}
    verification:
      type: exit_code

  - name: verify-commit-created
    type: deterministic
    dependsOn: [repair-commit]
    command: 'git log -1 --pretty=%s | grep -q "^feat: add pending status$" && echo "COMMIT_OK" || (echo "COMMIT_MISSING"; exit 1)'
    captureOutput: true
    failOnError: true
```


### File Materialization: Verify Before Proceeding

#### After any step that creates files, add a deterministic `file_exists` check before proceeding. Non-interactive agents may exit 0 without writing anything (wrong cwd, stdout instead of disk).

```yaml
- name: verify-files
  type: deterministic
  dependsOn: [impl-auth, impl-storage]
  command: |
    missing=0
    for f in src/auth/credentials.ts src/storage/client.ts; do
      if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi
    done
    if [ $missing -gt 0 ]; then echo "$missing files missing"; exit 1; fi
    echo "All files present"
  captureOutput: true
  failOnError: false

- name: fix-missing-files
  agent: impl-auth
  dependsOn: [verify-files]
  task: |
    If verify-files found missing files, create/fix them and rerun the check.
    Output:
    {{steps.verify-files.output}}
  verification:
    type: exit_code

- name: verify-files-final
  type: deterministic
  dependsOn: [fix-missing-files]
  command: |
    missing=0
    for f in src/auth/credentials.ts src/storage/client.ts; do
      if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi
    done
    if [ $missing -gt 0 ]; then echo "$missing files missing"; exit 1; fi
    echo "All files present"
  captureOutput: true
  failOnError: true
```

#### Edit Gates Must See Untracked Files

```yaml
- name: provider-edit-gate-capture
  type: deterministic
  dependsOn: [implement-providers]
  command: |
    if [ -z "$(git status --short -- packages/new-provider .workflow-artifacts/my-flow)" ]; then
      echo "NO_PROVIDER_CHANGES"
      exit 1
    fi
    echo "PROVIDER_EDIT_GATE_OK"
  captureOutput: true
  failOnError: false

- name: repair-edit-gate
  agent: provider-worker
  dependsOn: [provider-edit-gate-capture]
  task: |
    If provider-edit-gate-capture reported NO_PROVIDER_CHANGES, inspect git
    status including untracked files and add the missing provider artifacts.
    If it already passed, do nothing.
  verification:
    type: exit_code

- name: provider-edit-gate-final
  type: deterministic
  dependsOn: [repair-edit-gate]
  command: |
    if [ -z "$(git status --short -- packages/new-provider .workflow-artifacts/my-flow)" ]; then
      echo "NO_PROVIDER_CHANGES"
      exit 1
    fi
    echo "PROVIDER_EDIT_GATE_FINAL_OK"
  captureOutput: true
  failOnError: false

- name: repair-provider-edit-gate-final
  agent: provider-worker
  dependsOn: [provider-edit-gate-final]
  task: |
    If provider-edit-gate-final is still red, repair the missing provider
    artifacts and rerun the check. If repair is impossible, write
    .workflow-artifacts/my-flow/BLOCKED_NO_COMMIT.md with exact evidence and
    do not commit.
    Output:
    {{steps.provider-edit-gate-final.output}}
  verification:
    type: exit_code
```


### Agent Transport Must Not Be The First Hard Gate

#### Interactive lead-and-worker teams are useful, but they are still process

```typescript
.step('runtime-implementation', {
  agent: 'impl-runtime',
  dependsOn: ['context'],
  task: 'Implement the runtime slice and write .workflow-artifacts/runtime.md',
  failOnError: false,   // transport failure is advisory, not a hard gate
})
.step('adapter-implementation', {
  agent: 'impl-adapters',
  dependsOn: ['context'],
  task: 'Implement adapter wiring and write .workflow-artifacts/adapters.md',
  failOnError: false,   // transport failure is advisory, not a hard gate
})
.step('implementation-reconcile', {
  type: 'deterministic',
  // Depend on the agent steps so reconcile runs AFTER they finish (not in
  // parallel via a shared 'context' dep). They are failOnError:false above,
  // so a transport failure stays advisory while ordering is preserved.
  dependsOn: ['runtime-implementation', 'adapter-implementation'],
  command: `git status --short -- packages/core packages/*/src/writeback.ts scripts tests .workflow-artifacts
test -f scripts/verify-e2e.mjs || echo "MISSING_E2E"
test -f packages/core/src/runtime/router.ts || echo "MISSING_ROUTER"`,
  captureOutput: true,
  failOnError: false,
})
.step('repair-implementation-reconcile', {
  agent: 'qa',
  dependsOn: ['implementation-reconcile'],
  task: `Finish anything missing before gates run:\n{{steps.implementation-reconcile.output}}`,
  verification: { type: 'exit_code' },
})
.step('run-e2e', {
  type: 'deterministic',
  dependsOn: ['repair-implementation-reconcile'],
  command: 'npm run verify:e2e',
  captureOutput: true,
  failOnError: false,
})
```


### DAG Deadlock Anti-Pattern

#### ```yaml

```yaml
# WRONG — deadlock: coordinate depends on context, work-a depends on coordinate
steps:
  - name: coordinate
    dependsOn: [context]    # lead waits for WORKER_DONE...
  - name: work-a
    dependsOn: [coordinate] # ...but work-a can't start until coordinate finishes

# RIGHT — workers and lead start in parallel
steps:
  - name: context
    type: deterministic
  - name: work-a
    dependsOn: [context]    # starts with lead
  - name: coordinate
    dependsOn: [context]    # starts with workers
  - name: merge
    dependsOn: [work-a, coordinate]
```


### Step Sizing

#### **One agent, one deliverable.** A step's task prompt should be 10-20 lines max.

```yaml
# Team pattern: lead + workers on a shared channel
steps:
  - name: track-lead-coord
    agent: track-lead
    dependsOn: [prior-step]
    task: |
      Lead the track on #my-track. Workers: track-worker-1, track-worker-2.
      Post assignments to the channel. Review worker output.

  - name: track-worker-1-impl
    agent: track-worker-1
    dependsOn: [prior-step]  # same dep as lead — starts concurrently
    task: |
      Join #my-track. track-lead will post your assignment.
      Implement the file as directed.
    verification:
      type: exit_code

  - name: next-step
    dependsOn: [track-lead-coord]  # downstream depends on lead, not workers
```


### Supervisor Pattern

When you set `.pattern('supervisor')` (or `hub-spoke`, `fan-out`), the runner auto-assigns a supervisor agent as owner for worker steps. The supervisor monitors progress, nudges idle workers, and issues `OWNER_DECISION`.

**Auto-hardening only activates for hub patterns** — not `pipeline` or `dag`.

| Use case | Pattern | Why |
|----------|---------|-----|
| Sequential, no monitoring | `pipeline` | Simple, no overhead |
| Workers need oversight | `supervisor` | Auto-owner monitors |
| Local/small models | `supervisor` | Supervisor catches stuck workers |
| All non-interactive | `pipeline` or `dag` | No PTY = no supervision needed |

### Concurrency

**Cap `maxConcurrency` at 4-6.** Spawning 10+ agents simultaneously causes broker timeouts.

| Parallel agents | `maxConcurrency` |
|-----------------|-------------------|
| 2-4             | 4 (default safe)  |
| 5-10            | 5                 |
| 10+             | 6-8 max           |

### Common Mistakes

| Mistake | Fix |
|---------|-----|
| Treating relay as transport, not as a coordination layer (every step is `preset: 'worker'`, every handoff is `{{steps.X.output}}`) | Default to **Conversation shape** for non-trivial work — interactive agents on a shared channel. Pipeline-shape is only correct when the work could be expressed as a `bash \| bash \| bash` pipe. |
| Interactive agents on a channel whose task strings don't tell them to talk to each other | Pick a [Chat-Native Coordination Recipe](#chat-native-coordination-recipes) (Q/A, Broadcast/Ack, Peer Review, Standup, Hand-Off) and bake it into the task prompt — otherwise you're paying for a chat substrate you're not using |
| All workflows run sequentially | Group independent workflows into parallel waves (4-7x speedup) |
| Every step depends on the previous one | Only add `dependsOn` when there's a real data dependency |
| Self-review step with no timeout | Set `timeout: 300_000` (5 min) — Codex hangs in non-interactive review |
| One giant workflow per feature | Split into smaller workflows that can run in parallel waves |
| Adding exit instructions to tasks | Runner handles self-termination automatically |
| Interactive PTY Codex for one-shot artifact steps | Use `preset: 'worker'` plus `file_exists` or `custom` verification |
| Setting `timeoutMs` on agents/steps | Use global `.timeout()` only |
| Using `general` channel | Set `.channel('wf-name')` for isolation |
| `{{steps.X.output}}` without `dependsOn: ['X']` | Output won't be available yet |
| Requiring exact sentinel as only completion gate | Use `exit_code` or `file_exists` verification |
| Writing 100-line task prompts | Split into lead + workers on a channel |
| `maxConcurrency: 16` with many parallel steps | Cap at 5-6 |
| Non-interactive agent reading large files via tools | Pre-read in deterministic step, inject via `{{steps.X.output}}` |
| Workers depending on lead step (deadlock) | Both depend on shared context step |
| Validation gates depending directly on long interactive implementation agents | Add a deterministic implementation-reconcile step and make gates depend on its repair step |
| `fan-out`/`hub-spoke` for simple parallel workers | Use `dag` instead |
| `pipeline` but expecting auto-supervisor | Only hub patterns auto-harden. Use `.pattern('supervisor')` |
| Workers without `preset: 'worker'` in one-shot DAG lead+worker flows | Add preset for clean stdout when chaining `{{steps.X.output}}` (not needed for interactive team patterns) |
| Using `_` in YAML numbers (`timeoutMs: 1_200_000`) | YAML doesn't support `_` separators |
| Workflow timeout under 30 min for complex workflows | Use `3600000` (1 hour) as default |
| Using `require()` in ESM projects | Check `package.json` for `"type": "module"` — use `import` if ESM |
| Raw top-level `await` in workflow files | Executor paths may compile as CJS. Wrap `.run()` in `async function runWorkflow()` for both ESM and CJS files |
| Using `createWorkflowRenderer` | Does not exist. Use `.run({ cwd: process.cwd() })` |
| `export default workflow(...)...build()` | No `.build()`. Chain ends with `.run()` — the file must call `.run()`, not just export config |
| Relative import `'../workflows/builder.js'` | Use `import { workflow } from '@agent-relay/sdk/workflows'` |
| Hardcoded model strings (`model: 'opus'`) | Use constants: `import { ClaudeModels } from '@agent-relay/config'` → `model: ClaudeModels.OPUS` |
| Thinking `agent-relay run` inspects exports | It executes the file as a subprocess. Only `.run()` invocations trigger steps |
| `pattern('single')` on cloud runner | Not supported — use `dag` |
| `pattern('supervisor')` with one agent | Same agent is owner + specialist. Use `dag` |
| Invalid verification type (`type: 'deterministic'`) | Only `exit_code`, `output_contains`, `file_exists`, `custom`, `pr_url` are valid |
| Chaining `{{steps.X.output}}` from interactive agents | PTY output is garbled. Use deterministic steps or `preset: 'worker'` |
| Single step editing 4+ files | Agents modify 1-2 then exit. Split to one file per step with verify gates |
| Relying on agents to `git commit` | Agents emit markers without running git. Use deterministic commit step |
| File-writing steps without `file_exists` verification | `exit_code` auto-passes even if no file written |
| Codex login checked only with `codex login status` | Add a tiny `codex exec --ephemeral --json --sandbox read-only` preflight probe so stale refresh tokens fail before agent steps |
| Edit gate uses `git diff --quiet` for new files/packages | `git diff` ignores untracked files and can fail a valid implementation with `NO_CHANGES`; use `git status --short -- <paths>` for materialization gates |
| Hard-stop validation gates in product workflows | A red check stops the agent team at the exact moment it should fix the problem. Capture gate output with `failOnError: false`, add a repair agent step, rerun, and reserve hard failure for exhausted repair budget or external blockers |
| Final acceptance before repair and required review | Broken work can stop or commit without giving the team a final chance to fix it. Run repairable gates first, then the selected review-depth review/fix loop, then final deterministic acceptance before commit/PR |
| Skipping required review-depth loops | Add the review/fix loop required for the selected review depth after repairable verification and before final acceptance, commit, PR creation, or handoff; deep tier requires sequential Claude-then-Codex fresh-eyes loops |
| Treating optional notification credentials as fatal | Workflow progress gets blocked by a non-core side effect. Prefer primitive/runtime fallbacks such as the Slack primitive's `cloud-relay` or `noop` shape from AgentWorkforce/relay#823 when notification is not the product contract |
| Manual peer fanout in `handleChannelMessage()` | Use broker-managed channel subscriptions — broker fans out to all subscribers automatically |
| Client-side `personaNames.has(from)` filtering | Use `relay.subscribe()`/`relay.unsubscribe()` — only subscribed agents receive messages |
| Agents receiving noisy cross-channel messages during focused work | Use `relay.mute({ agent, channel })` to silence non-primary channels without leaving them |
| Hardcoding all channels at spawn time | Use `agent.subscribe()` / `agent.unsubscribe()` for dynamic channel membership post-spawn |
| Using `preset: 'worker'` for Codex in *interactive team* patterns when coordination is needed | Codex interactive mode works fine with PTY channel injection. Drop the preset for interactive team patterns (keep it for one-shot DAG workers where clean stdout matters) |
| Treating the lead's informal review as final signoff | The lead may review during implementation, but final signoff still requires the selected review-depth fresh-eyes loop and final deterministic acceptance |
| Not printing PR URL after `createGitHubStep({ name: 'open-pr', action: 'createPR' })` | Capture `html_url` with `output: { mode: 'data', format: 'json', path: 'html_url' }` and echo or write it in a final deterministic step |
| Workflow ending without worktree + PR for cross-repo changes | Add `setup-worktree` at start and `push-and-pr` + `cleanup-worktree` at end |

### YAML Alternative

#### ```yaml

```yaml
version: '1.0'
name: my-workflow
swarm:
  pattern: dag
  channel: wf-my-workflow
agents:
  - name: lead
    cli: claude
    role: Architect
  - name: worker
    cli: codex
    role: Implementer
  - name: claude-reviewer
    cli: claude
    preset: reviewer
    role: First-pass fresh-eyes reviewer
  - name: claude-fixer
    cli: claude
    role: First-pass review fixer
  - name: codex-reviewer
    cli: codex
    preset: reviewer
    role: Second-pass fresh-eyes reviewer
  - name: codex-fixer
    cli: codex
    role: Second-pass review fixer
workflows:
  - name: default
    steps:
      - name: plan
        agent: lead
        task: 'Produce a detailed implementation plan.'
      - name: implement
        agent: worker
        task: 'Implement: {{steps.plan.output}}'
        dependsOn: [plan]
        verification:
          type: exit_code
      - name: claude-review
        agent: claude-reviewer
        dependsOn: [implement]
        task: 'Review actual files, diff, rules, and evidence. Write .workflow-artifacts/my-workflow/claude-review.md with findings or NO_ISSUES_FOUND.'
      - name: claude-fix
        agent: claude-fixer
        dependsOn: [claude-review]
        task: 'Fix valid Claude review findings, add or update appropriate tests/proofs, rerun relevant checks, and write .workflow-artifacts/my-workflow/claude-fix.md.'
      - name: claude-review-final
        agent: claude-reviewer
        dependsOn: [claude-fix]
        task: 'Review the post-Claude-fix state from scratch and write .workflow-artifacts/my-workflow/claude-review-final.md.'
      - name: claude-fix-final
        agent: claude-fixer
        dependsOn: [claude-review-final]
        task: 'Fix remaining Claude findings, add/update tests or proofs, or write .workflow-artifacts/my-workflow/BLOCKED_NO_COMMIT.md.'
      - name: codex-review
        agent: codex-reviewer
        dependsOn: [claude-fix-final]
        task: 'Review the post-Claude-fix state from scratch. Write .workflow-artifacts/my-workflow/codex-review.md with findings or NO_ISSUES_FOUND.'
      - name: codex-fix
        agent: codex-fixer
        dependsOn: [codex-review]
        task: 'Fix valid Codex review findings, add or update appropriate tests/proofs, rerun relevant checks, and write .workflow-artifacts/my-workflow/codex-fix.md.'
      - name: codex-review-final
        agent: codex-reviewer
        dependsOn: [codex-fix]
        task: 'Review the post-Codex-fix state from scratch and write .workflow-artifacts/my-workflow/codex-review-final.md.'
      - name: codex-fix-final
        agent: codex-fixer
        dependsOn: [codex-review-final]
        task: 'Fix remaining Codex findings, add/update tests or proofs, or write .workflow-artifacts/my-workflow/BLOCKED_NO_COMMIT.md.'
      - name: acceptance-after-review
        type: deterministic
        dependsOn: [codex-fix-final]
        command: 'test ! -f .workflow-artifacts/my-workflow/BLOCKED_NO_COMMIT.md && echo ACCEPTANCE_OK'
        captureOutput: true
        failOnError: true
```


### Available Swarm Patterns

`dag` (default), `fan-out`, `pipeline`, `hub-spoke`, `consensus`, `mesh`, `handoff`, `cascade`, `debate`, `hierarchical`, `map-reduce`, `scatter-gather`, `supervisor`, `reflection`, `red-team`, `verifier`, `auction`, `escalation`, `saga`, `circuit-breaker`, `blackboard`, `swarm`

See skill `choosing-swarm-patterns` for pattern selection guidance.
