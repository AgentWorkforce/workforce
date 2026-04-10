# Persona & Routing System Analysis for Workflow Auto-Generation

## 1. PERSONA CAPABILITIES

Each persona JSON file carries five categories of information relevant to workflow generation:

### 1.1 Identity & Intent Mapping

Every persona declares an `id` (e.g. `"security-reviewer"`) and an `intent` (e.g. `"security-review"`). The intent is the canonical key used by `resolvePersona()` in `packages/workload-router/src/index.ts` and by the routing profile to select the tier. A workflow generator must accept either the persona `id` or the `intent` and resolve to the correct `PersonaSpec` from `personaCatalog`.

The SDK provides two resolution paths:
- **Policy-driven**: `resolvePersona(intent, profile)` — uses a `RoutingProfile` to pick the tier. This is the preferred path for auto-generated workflows.
- **Legacy tier override**: `resolvePersonaByTier(intent, tier)` — bypasses routing profiles. Useful for explicit tier pinning but not recommended for generators.

Both return a `PersonaSelection` containing: `personaId`, `tier`, `runtime` (harness, model, systemPrompt, harnessSettings), `skills[]`, and `rationale`.

**Full intent-to-persona-id mapping (13 personas):**

| Intent | Persona ID | Description |
|--------|-----------|-------------|
| `implement-frontend` | `frontend-implementer` | UI feature implementation |
| `review` | `code-reviewer` | PR review for correctness/risk |
| `architecture-plan` | `architecture-planner` | Architecture plans and tradeoffs |
| `requirements-analysis` | `requirements-analyst` | Acceptance criteria from rough ideas |
| `debugging` | `debugger` | Root-cause debugging |
| `security-review` | `security-reviewer` | Security risk analysis |
| `documentation` | `technical-writer` | Developer-facing docs |
| `verification` | `verifier` | Completion evidence checking |
| `test-strategy` | `test-strategist` | Risk-ranked test plans |
| `tdd-enforcement` | `tdd-guard` | Red-green-refactor discipline |
| `flake-investigation` | `flake-hunter` | Intermittent test failure diagnosis |
| `opencode-workflow-correctness` | `opencode-workflow-specialist` | Cross-layer opencode workflow debugging |
| `npm-provenance` | `npm-provenance-publisher` | OIDC trusted npm publishing setup |

### 1.2 Tier-Keyed Runtimes

Each persona defines three tiers — `best`, `best-value`, `minimum` — each carrying:

- **`harness`**: The CLI tool to use (`codex`, `opencode`, or `claude`). This directly determines the `agent.cli` value in a generated workflow and affects skill installation paths via `HARNESS_SKILL_TARGETS`.
- **`model`**: The LLM model identifier (e.g. `openai-codex/gpt-5.3-codex`, `opencode/gpt-5-nano`).
- **`systemPrompt`**: The full behavioral prompt injected into the agent. This encodes the persona's quality bar, priorities, and output contract.
- **`harnessSettings.reasoning`**: `low`, `medium`, or `high` — influences agent reasoning depth.
- **`harnessSettings.timeoutSeconds`**: Per-step timeout, ranging from 300s (npm-provenance minimum) to 1500s (architecture-planner best, flake-hunter best, opencode-workflow-specialist best).

**Harness distribution by tier:**

| Tier | Harness Pattern |
|------|----------------|
| `best` | Always `codex` (all 13 personas) |
| `best-value` | Always `opencode` (all 13 personas) |
| `minimum` | Always `opencode` (all 13 personas) |

Note: The `claude` harness value is declared in `HARNESS_VALUES` and tested in the test suite (`index.test.ts:137`) but is not used by any current persona tier. The `finish-npm-provenance-persona.ts` workflow manually sets `cli: 'claude'` for its publisher agent, but the persona JSON itself specifies `opencode` at best-value.

**Model distribution:**

| Tier | Models Used |
|------|------------|
| `best` | `openai-codex/gpt-5.3-codex` (all 13) |
| `best-value` | `opencode/gpt-5-nano` (all 13) |
| `minimum` | `opencode/mimo-v2-flash-free` (5: frontend-implementer, debugger, flake-hunter, opencode-workflow-specialist, frontend-implementer), `opencode/minimax-m2.5-free` (5: code-reviewer, requirements-analyst, security-reviewer, tdd-guard, verifier), `opencode/nemotron-3-super-free` (3: architecture-planner, technical-writer, test-strategist) |

### 1.3 Skills

Only one persona currently declares skills:

- **`npm-provenance-publisher`** has one skill:
  - `id`: `prpm/npm-trusted-publishing`
  - `source`: `https://prpm.dev/packages/@prpm/npm-trusted-publishing`
  - `description`: Claude skill for configuring npm OIDC trusted publishing

All other 12 personas have an empty or absent `skills` array (the SDK's `parseSkills()` function defaults absent values to `[]`). This means the skill materialization pipeline (phases `plan-skills`, `install-skills`, `verify-skill-installed`) is only required for skill-bearing personas. A workflow generator should always check `spec.skills.length > 0` and include the pipeline conditionally.

The skill system is designed for expansion: the `PersonaSkill` interface (`id`, `source`, `description`) and `SkillSourceKind` type (currently only `'prpm'`) suggest future personas will declare skills backed by prpm packages. The `resolveSkillSource()` function already supports both full URLs (`https://prpm.dev/packages/<scope>/<name>`) and bare references (`<scope>/<name>`).

### 1.4 System Prompt Quality Contract

Every persona's system prompt follows a consistent structure across tiers:
1. **Role declaration** — "You are a senior X" / "You are a senior X in efficient mode" / "You are a concise X"
2. **Process steps** — numbered (1)-(5) workflow
3. **Quality bar assertion** — "Quality bar is fixed across tiers" (higher tiers) or "Enforce the same quality bar as all tiers; only limit detail" (minimum)
4. **Priority ordering** — explicit priority chain (e.g. "correctness > security > performance > maintainability > style")
5. **Anti-patterns** — "Avoid shortcuts/noise: do not..."
6. **Output contract** — what deliverables the persona must produce

This structure means the systemPrompt already embeds the task verification criteria. A workflow generator can parse the "Output contract" suffix of each prompt to derive verification gate expectations for that persona.

The prompt differentiation across tiers is purely about depth, not about quality:
- **`best`**: Full process, detailed output contract
- **`best-value`**: "Keep the same quality bar; reduce only depth and verbosity"
- **`minimum`**: "Enforce the same quality bar; only limit detail for latency"

### 1.5 Routing Profile Tier Selection

The default routing profile (`routing-profiles/default.json`, id `balanced-default`) maps each intent to a tier with a rationale. The tier selection reflects risk asymmetry:

**Tier assignments in default profile:**

| Tier | Intents | Selection Rationale |
|------|---------|---------------------|
| `best` | `architecture-plan`, `debugging`, `security-review`, `flake-investigation`, `opencode-workflow-correctness` | High-leverage or asymmetric-downside tasks where misdiagnosis is expensive |
| `best-value` | `implement-frontend`, `review`, `requirements-analysis`, `documentation`, `verification`, `test-strategy`, `tdd-enforcement`, `npm-provenance` | Iterative/mechanical work where quality-per-dollar matters more than maximum depth |
| `minimum` | (none in default profile) | Reserved for custom profiles targeting cost-sensitive workloads |

The routing profile is pluggable: `resolvePersona()` accepts either a profile ID string (mapped via `routingProfiles` const) or a full inline `RoutingProfile` object. The test suite (`index.test.ts:22-83`) demonstrates a custom `fast-review` profile that assigns different tiers. This means a generator should accept an optional profile parameter, defaulting to `'default'`.

### 1.6 Eval Framework (Future)

The SDK exports an eval subsystem (`packages/workload-router/src/eval.ts`) with `EvalCase` and `EvalResult` interfaces plus a `summarizeEval()` function. This is currently a placeholder for benchmarking persona/tier combinations on quality, cost, and latency. A workflow generator could eventually use eval data to inform tier selection or pattern choice, but this is not yet implemented.

---

## 2. PATTERN SELECTION HEURISTICS

### 2.1 Pattern Definitions (from the choosing-swarm-patterns skill)

- **DAG**: Directed acyclic graph of steps with explicit dependencies. Best for workflows with parallel branches that converge.
- **Pipeline**: Linear sequence of steps. Best for single-agent tasks with clear sequential stages.
- **Fan-out**: One step fans out to N parallel agents doing similar work on different inputs. Best for batch processing.
- **Hub-spoke**: Central coordinator dispatches to specialized agents. Best for multi-concern analysis.
- **Cascade**: Try cheaper/faster agent first, escalate to more capable if needed. Best for cost-optimized uncertain tasks.
- **Handoff**: One agent completes its phase and hands off to the next specialized agent. Best for multi-phase sequential work.

### 2.2 Intent-to-Pattern Matrix

| Intent | Recommended Pattern | Reasoning |
|--------|-------------------|-----------|
| `implement-frontend` | **DAG** | Needs parallel context gathering (read component files, check design patterns), then sequential implementation + multiple verification gates (a11y, tests, build). |
| `review` | **DAG** | Read diff + changed files in parallel, then sequential review + output. DAG enables parallel pre-reads even though the core review is sequential. |
| `architecture-plan` | **DAG** | Parallel reads of multiple codebase areas, convergent analysis. Could benefit from **hub-spoke** for multi-subsystem reviews, but DAG is the safe default. |
| `requirements-analysis` | **Pipeline** | Fundamentally sequential: read input → analyze → produce requirements → verify. Little opportunity for parallel pre-work beyond initial context reads. |
| `debugging` | **DAG** | Parallel evidence gathering (logs, stack traces, diffs, test output), then convergent root-cause analysis. Multiple verification reruns after fix. |
| `security-review` | **DAG** | Parallel reads of trust boundaries, auth paths, input handling code. Convergent threat analysis. Could use **hub-spoke** for multi-subsystem reviews. |
| `documentation` | **Pipeline** | Sequential: read code → write docs → verify accuracy. Minimal parallelism beyond initial file reads. |
| `verification` | **DAG** | Parallel checking of multiple acceptance criteria. Each criterion is independently verifiable, then results converge to a pass/fail verdict. |
| `test-strategy` | **DAG** | Parallel reads of changed code + existing tests + coverage data, convergent strategy synthesis. |
| `tdd-enforcement` | **Pipeline** | Inherently sequential red-green-refactor cycles. Each cycle depends on the previous cycle's outcome. |
| `flake-investigation` | **DAG** | Parallel reproduction runs + log analysis, convergent root-cause identification. Multiple verification loops needed. |
| `opencode-workflow-correctness` | **DAG** | Parallel layer inspection (SDK spawn, broker headless worker, opencode CLI, cloud bootstrap), convergent cross-layer diagnosis. Complex enough to potentially benefit from **hub-spoke**. |
| `npm-provenance` | **DAG** | Proven pattern from existing workflows. Parallel context reads + skill install, convergent task execution, parallel verification gates. |

**Summary**: DAG is the dominant pattern (10/13 intents). Pipeline suits 3 intents with inherently sequential workflows (`requirements-analysis`, `documentation`, `tdd-enforcement`). Hub-spoke and cascade are useful advanced optimizations on top of DAG for multi-subsystem analysis.

### 2.3 Pattern Selection Decision Tree

```
Has the persona declared skills?
├── YES → DAG (skill install creates a parallel branch alongside context reads)
└── NO
    Is the task inherently sequential (each step depends on prior output)?
    ├── YES → Pipeline (requirements-analysis, documentation, tdd-enforcement)
    └── NO
        Does the task need parallel evidence gathering from multiple sources?
        ├── YES → DAG (review, debugging, investigation, verification, test-strategy)
        └── NO → Pipeline (fallback for simple single-agent tasks)
```

### 2.4 Persona Type Grouping for Pattern Defaults

| Persona Type | Personas | Default Pattern | Agent Preset |
|-------------|----------|-----------------|-------------|
| **Implementers** | `frontend-implementer`, `npm-provenance-publisher` | DAG | `worker` |
| **Reviewers** | `code-reviewer`, `security-reviewer` | DAG | `analyst` |
| **Analysts** | `requirements-analyst`, `test-strategist`, `architecture-planner` | DAG (arch, test) / Pipeline (req) | `analyst` |
| **Debuggers** | `debugger`, `flake-hunter`, `opencode-workflow-specialist` | DAG | `worker` |
| **Process enforcers** | `tdd-guard`, `verifier` | Pipeline (tdd) / DAG (verifier) | `worker` (tdd) / `analyst` (verifier) |
| **Writers** | `technical-writer` | Pipeline | `worker` |

---

## 3. SKILL MATERIALIZATION

### 3.1 The Materialization Pipeline

The SDK provides a pure-function pipeline for deriving skill install plans without touching the filesystem. The flow is:

1. **`resolvePersona(intent, profile)`** → returns `PersonaSelection` with `skills[]` and `runtime.harness`
2. **`materializeSkillsFor(selection)`** → calls `materializeSkills(selection.skills, selection.runtime.harness)`
3. **`materializeSkills(skills, harness)`** → produces `SkillMaterializationPlan` with `installs[]`
4. Each `SkillInstall` contains:
   - `skillId`: The skill's `id` field from the persona JSON
   - `source`: Original source URL or bare ref
   - `sourceKind`: Always `'prpm'` currently
   - `packageRef`: Normalized reference (e.g. `prpm/npm-trusted-publishing`)
   - `harness`: The target harness
   - `installCommand`: Frozen argv-style array `['npx', '-y', 'prpm', 'install', '<packageRef>', '--as', '<asFlag>']`
   - `installedDir`: Where the skill lands (e.g. `.opencode/skills/npm-trusted-publishing`)
   - `installedManifest`: Path to `SKILL.md` (e.g. `.opencode/skills/npm-trusted-publishing/SKILL.md`)

### 3.2 Harness-to-Directory Mapping

Defined in `HARNESS_SKILL_TARGETS` constant:

| Harness | `asFlag` | Install Directory | Manifest Path |
|---------|----------|-------------------|---------------|
| `claude` | `claude` | `.claude/skills/<name>` | `.claude/skills/<name>/SKILL.md` |
| `codex` | `codex` | `.agents/skills/<name>` | `.agents/skills/<name>/SKILL.md` |
| `opencode` | `opencode` | `.opencode/skills/<name>` | `.opencode/skills/<name>/SKILL.md` |

### 3.3 Source Resolution

`resolveSkillSource()` handles two forms:
- **Full URL**: `https://prpm.dev/packages/@prpm/npm-trusted-publishing` → extracts path segments as `packageRef`
- **Bare ref**: `prpm/npm-trusted-publishing` → used directly as `packageRef`

The function throws on unrecognized forms (tested in `index.test.ts:227-242`). `deriveInstalledName()` extracts the name after the last slash for the install directory name.

### 3.4 Required Workflow Steps for Skill-Bearing Personas

Every auto-generated workflow for a persona with `skills.length > 0` needs these steps:

```
install-deps          → corepack pnpm install [--frozen-lockfile]
build-sdk             → corepack pnpm --filter @agentworkforce/workload-router run build
plan-skills           → node -e "...resolvePersona + materializeSkillsFor..."  (captureOutput)
install-skills        → node -e "...spawnSync each install command..."
verify-skill-installed → test -f <installedManifest> (for each skill)
```

For skillless personas, `plan-skills`, `install-skills`, and `verify-skill-installed` are omitted entirely, and the agent execution step depends only on `build-sdk` + context reads.

### 3.5 Existing Workflow Implementation Details

The `plan-skills` and `install-skills` steps in both `configure-trusted-publishing.ts` and `finish-npm-provenance-persona.ts` use identical `node -e` one-liners that differ only in the intent string passed to `resolvePersona()`. This is the strongest signal that these steps are template-ready.

**plan-skills one-liner structure** (from `configure-trusted-publishing.ts:66-88`):
```js
const {resolvePersona, materializeSkillsFor} = require('./packages/workload-router/dist/index.js');
const plan = materializeSkillsFor(resolvePersona('<INTENT>'));
for (const install of plan.installs) {
  process.stdout.write(install.installCommand.join(' ') + '\n');
}
```

**install-skills one-liner structure** (from `configure-trusted-publishing.ts:91-110`):
```js
const {spawnSync} = require('child_process');
const {resolvePersona, materializeSkillsFor} = require('./packages/workload-router/dist/index.js');
const plan = materializeSkillsFor(resolvePersona('<INTENT>'));
for (const install of plan.installs) {
  console.log('[install]', install.skillId, '->', install.installedManifest);
  const r = spawnSync(install.installCommand[0], install.installCommand.slice(1), {stdio: 'inherit'});
  if (r.status !== 0) process.exit(r.status || 1);
}
```

### 3.6 Current Limitation: Hard-Coded Verify Paths

The `verify-skill-installed` step in existing workflows hard-codes the expected path:
- `configure-trusted-publishing.ts:109`: checks `.opencode/skills/npm-trusted-publishing` (directory)
- `finish-npm-provenance-persona.ts:121`: checks `.claude/skills/npm-trusted-publishing/SKILL.md` (manifest file)

These differ because the two workflows target different harnesses. A proper workflow generator should derive this path from `materializeSkillsFor()` output (specifically `install.installedManifest` or `install.installedDir`) rather than hard-coding it. The generator could emit a `verify-skill-installed` step that runs:
```js
const {resolvePersona, materializeSkillsFor} = require('./packages/workload-router/dist/index.js');
const plan = materializeSkillsFor(resolvePersona('<INTENT>'));
for (const install of plan.installs) {
  const fs = require('fs');
  if (!fs.existsSync(install.installedManifest)) {
    console.error('MISSING:', install.installedManifest);
    process.exit(1);
  }
  console.log('OK:', install.installedManifest);
}
```

---

## 4. COMMON WORKFLOW STRUCTURE

Based on the three existing workflows (`configure-trusted-publishing.ts`, `finish-npm-provenance-persona.ts`, `investigate-agent-profile-workflows.ts`), every persona-driven workflow follows this canonical step ordering:

### 4.1 Canonical DAG Structure

```
Phase 1: BOOTSTRAP (deterministic, always present)
├── install-deps          → corepack pnpm install [--frozen-lockfile]
└── build-sdk             → pnpm --filter @agentworkforce/workload-router run build
                            (depends on install-deps)

Phase 2: SKILL MATERIALIZATION (deterministic, conditional on skills.length > 0)
├── plan-skills           → resolvePersona + materializeSkillsFor → stdout install commands
│                           (depends on build-sdk)
├── install-skills        → spawnSync each install command
│                           (depends on plan-skills)
└── verify-skill-installed → test -f <installedManifest>
                             (depends on install-skills)

Phase 3: CONTEXT GATHERING (deterministic, parallel reads)
├── read-<input-1>        → cat <relevant-file-1>   (captureOutput)
├── read-<input-2>        → cat <relevant-file-2>   (captureOutput)
└── read-<input-N>        → ...
    (no dependencies on each other; may depend on install-deps for file existence)

Phase 4: TASK EXECUTION (agent step, the core work)
└── execute-task          → agent performs the persona's job
                            (depends on verify-skill-installed OR build-sdk + all read-* steps)
                            Uses {{steps.read-<input>.output}} template vars
                            verification: { type: 'exit_code' } or { type: 'file_exists' }

Phase 5: OUTPUT VERIFICATION (deterministic, parallel gates)
├── verify-<check-1>      → grep/test specific output requirement
├── verify-<check-2>      → ...
└── verify-<check-N>      → ...
    (each depends on execute-task)

Phase 6: FINAL GATE (agent or deterministic)
├── check                 → pnpm run check (or equivalent repo-wide lint/test)
│                           (depends on all verify-* steps)
└── git-diff/git-status   → capture changed files for reporting
                            (depends on check)
```

### 4.2 Workflow Metadata (invariant across all workflows)

Every workflow declares:
- **`.pattern('dag')`** — always DAG in existing examples
- **`.channel('wf-<workflow-name>')`** — convention: `wf-` prefix + workflow name
- **`.maxConcurrency(4)`** — default parallelism limit
- **`.timeout(3_600_000)`** — 1 hour default
- **`.onError('fail-fast')`** — stop on first failure

### 4.3 Agent Declarations

Workflows declare agents with:
```js
.agent('<name>', {
  cli: '<harness>',        // from persona tier: 'opencode', 'codex', or 'claude'
  preset: 'worker',        // or 'analyst' for read-only tasks
  role: '<description>',   // from persona.description or a task-specific role
  retries: 2               // default: 2 for main agent, 1 for checker
})
```

A typical workflow has two agents:
1. **Primary agent** — does the persona's work (cli from persona tier's harness)
2. **Checker agent** — always `cli: 'codex'`, `preset: 'worker'`, `retries: 1`, runs `pnpm run check`

The investigation workflow breaks this pattern with three agents (analyst + planner + generator), but this is a multi-phase research workflow — standard persona-driven workflows use the two-agent pattern.

### 4.4 CJS Execution Wrapper (100% invariant)

```js
const { workflow } = require('@agent-relay/sdk/workflows');

async function main() {
  const result = await workflow('<name>')
    // ... chain ...
    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### 4.5 Step Output Interpolation

The template engine uses `{{steps.<stepId>.output}}` for injecting captured output from prior steps. Steps that need their output injected into later task prompts must set `captureOutput: true`. This is the only interpolation syntax observed in existing workflows.

---

## 5. VARIABLE PARTS

### 5.1 Per-Persona Variables (derived from SDK resolution)

| Variable | Source | Example |
|----------|--------|---------|
| Agent CLI | `persona.tiers[tier].harness` | `opencode` for best-value npm-provenance |
| Agent model | `persona.tiers[tier].model` | `opencode/gpt-5-nano` |
| System prompt | `persona.tiers[tier].systemPrompt` | Full behavioral prompt |
| Timeout | `persona.tiers[tier].harnessSettings.timeoutSeconds` | 600-1500 |
| Reasoning depth | `persona.tiers[tier].harnessSettings.reasoning` | `low`/`medium`/`high` |
| Skills to install | `persona.skills[]` | `[{ id: 'prpm/npm-trusted-publishing', ... }]` or `[]` |
| Skill install dir | `HARNESS_SKILL_TARGETS[harness].dir` | `.opencode/skills/` |
| Skill manifest path | `materializeSkillsFor().installs[n].installedManifest` | `.opencode/skills/npm-trusted-publishing/SKILL.md` |
| Selected tier | `routingProfile.intents[intent].tier` | `best-value` |
| Tier rationale | `routingProfile.intents[intent].rationale` | "Publishing setup is mostly mechanical" |

### 5.2 Per-Task Variables (NOT in persona — must come from task description or CLI args)

| Variable | Source | Example |
|----------|--------|---------|
| Context files to read | Task description parsing / heuristic by intent | `git diff`, `cat package.json` |
| Task prompt | User-provided task description + persona systemPrompt | "review this PR for security" |
| Output file targets | Task type heuristic | `security-review.md`, modified `.yml` |
| Verification gates | Task type + persona intent | grep for specific output markers |
| Allowed modification scope | Task description | "Only modify .github/workflows/publish.yml" |

### 5.3 Verification Strategy by Persona Type

| Persona Type | Personas | Verification Strategy | Example Gates |
|-------------|----------|----------------------|---------------|
| **Implementers** | `frontend-implementer`, `npm-provenance-publisher` | File modification + content checks | `grep -q "id-token: write" publish.yml`, `test -f <output>`, `node -e` JSON field checks |
| **Reviewers** | `code-reviewer`, `security-reviewer` | Output document existence + structured content | `test -f review-findings.md`, grep for section headers |
| **Analysts** | `requirements-analyst`, `test-strategist`, `architecture-planner` | Output document existence with expected sections | `test -f analysis.md`, grep for required section markers |
| **Debuggers** | `debugger`, `flake-hunter`, `opencode-workflow-specialist` | Re-execution of failing scenario | Rerun failing test/command, check exit code 0 |
| **Process enforcers** | `tdd-guard`, `verifier` | Evidence freshness validation | Verify test output timestamps are current, claims match evidence |
| **Writers** | `technical-writer` | Output existence + code reference accuracy | `test -f docs.md`, grep for expected code references |

### 5.4 Context Gathering Heuristics by Intent

| Intent | Likely Context Reads | Commands |
|--------|---------------------|----------|
| `implement-frontend` | Target component files, existing patterns, design specs | `cat src/components/*.tsx`, `cat package.json` |
| `review` | Recent diff, changed files list | `git diff HEAD~1`, `git status --short` |
| `architecture-plan` | Relevant source dirs, dependency graph, existing docs | `cat tsconfig.json`, `cat package.json`, `find src -name '*.ts'` |
| `requirements-analysis` | Issue/ticket content, related code, existing specs | `cat <issue-file>`, `cat <spec-file>` |
| `debugging` | Error logs, stack traces, failing test output | `cat <log>`, `git diff`, test runner stderr |
| `security-review` | Recent diff, auth/input handling code | `git diff HEAD~1`, `cat src/auth/*`, `cat <config>` |
| `documentation` | Target code files, existing docs, API surface | `cat src/<target>.ts`, `cat README.md` |
| `verification` | Acceptance criteria, test output, diff | `cat <criteria>`, test runner output, `git diff` |
| `test-strategy` | Source files under test, existing test files | `cat src/**/*.ts`, `cat src/**/*.test.ts` |
| `tdd-enforcement` | Current test file, implementation file, test runner output | `cat <test>.ts`, `cat <impl>.ts`, test runner stdout |
| `flake-investigation` | CI logs, flaky test file, runner history | `cat <ci-log>`, `cat <test>.ts` |
| `opencode-workflow-correctness` | SDK source, broker logs, opencode config, auth state | `cat packages/*/src/*.ts`, `cat ~/.local/share/opencode/auth.json` |
| `npm-provenance` | package.json, existing publish workflow | `cat package.json`, `cat .github/workflows/publish.yml` |

### 5.5 Agent Preset Selection

| Persona Behavior | Preset | Reasoning |
|-----------------|--------|-----------|
| Code/config modification (`implement-frontend`, `debugging`, `npm-provenance`, `flake-investigation`, `opencode-workflow-correctness`) | `worker` | Agent modifies files on disk |
| Read-only analysis (`review`, `security-review`, `requirements-analysis`, `test-strategy`, `verification`, `architecture-plan`) | `analyst` | Agent reads code and produces analysis; does not modify source |
| Process coaching (`tdd-enforcement`) | `worker` | Agent may need to create/modify test files |
| Documentation (`documentation`) | `worker` | Agent creates/modifies doc files |

### 5.6 Error Handling by Step Type

| Step Category | `failOnError` | Retries | Rationale |
|---|---|---|---|
| Bootstrap (install, build) | `true` | 0 | No point continuing if deps don't install |
| Skill materialization | `true` | 0 | Agent can't work without its skills |
| Context reads | `true` | 0 | Missing context = broken prompt |
| Agent execution (implementer/debugger) | N/A (agent step) | 2 | LLM agents are non-deterministic; file-modifying tasks need more retries |
| Agent execution (reviewer/analyst) | N/A (agent step) | 1 | Analysis is idempotent and lower-risk |
| Verification gates | `true` | 0 | Deterministic checks — if they fail, the output is wrong |
| Checker agent | N/A (agent step) | 1 | Final gate; `codex` is reliable for shell commands |
| Git diff/status (informational) | `false` | 0 | Purely informational — never blocks |

---

## Summary: What a Workflow Generator Needs

To auto-generate a workflow from `agent-relay run "task" --agent <persona-id>`:

1. **Resolve** persona: by id → intent → `personaCatalog[intent]`, or by id → lookup `personaCatalog` values where `spec.id === personaId`
2. **Select** tier: via `resolvePersona(intent, 'default')` using the routing profile (or accept optional `--profile` / `--tier` overrides)
3. **Extract** runtime config: `harness`, `model`, `timeoutSeconds`, `reasoning` from `selection.runtime`
4. **Check** `selection.skills.length > 0` — if yes, include the skill materialization pipeline (phases B)
5. **Determine** pattern: DAG (default for most), Pipeline (for `requirements-analysis`, `documentation`, `tdd-enforcement`)
6. **Generate** context reads based on intent + task description heuristics (phase C)
7. **Generate** agent definition with `cli` from `selection.runtime.harness`, `preset` from persona type grouping
8. **Generate** task execution step with persona's systemPrompt injected and context vars templated via `{{steps.<id>.output}}` (phase D)
9. **Generate** verification gates appropriate to the persona type (phase E)
10. **Add** universal checker agent + `pnpm run check` gate (phase F)
11. **Set** `onError('fail-fast')`, `maxConcurrency(4)`, `timeout(3_600_000)`

The canonical SDK code path is:
```ts
import { resolvePersona, materializeSkillsFor, personaCatalog } from '@agentworkforce/workload-router';

const selection = resolvePersona(intent, profile);    // → PersonaSelection
const skillPlan = materializeSkillsFor(selection);     // → SkillMaterializationPlan
// Generator uses selection + skillPlan to emit workflow steps
```

All persona-independent values (bootstrap steps, checker agent, CJS wrapper, error strategy, metadata) are template constants. All persona-dependent values (harness, skills, agent preset, verification strategy) are derivable from the SDK's resolution functions. The only truly task-specific inputs that cannot be derived are: `contextFiles`, `taskPrompt`, `verificationGates`, and `finalCaptureTarget`.
