# Design Plan: `agent-relay run --agent` Flag

> Auto-generate and execute agent-relay workflows from persona profiles.

**Target UX:**
```bash
agent-relay run "configure trusted publishing" --agent npm-provenance-publisher
agent-relay run "review this PR for security issues" --agent security-reviewer
agent-relay run "debug the flaky auth test" --agent debugger
```

---

## CLI Interface

### Flag syntax

```
agent-relay run "<task-description>" --agent <persona-ref> [options]
```

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `<task-description>` | positional string | Yes | Free-text description of what the agent should do |
| `--agent` | string | Yes (for this feature) | Persona ID or intent. Triggers workflow auto-generation instead of loading a `.ts` file |
| `--profile` | string | No | Routing profile ID. Defaults to `"default"` |
| `--tier` | `best` \| `best-value` \| `minimum` | No | Override the routing profile's tier selection |
| `--dry-run` | boolean | No | Print the generated workflow to stdout without executing |
| `--context` | string[] | No | Additional files to read as context (repeatable: `--context src/index.ts --context package.json`) |
| `--verify` | string[] | No | Additional verification commands (repeatable: `--verify 'grep -q "id-token" .github/workflows/publish.yml'`) |
| `--output` | string | No | Expected output file path (adds a `file_exists` verification gate) |
| `--concurrency` | number | No | Max parallel steps. Defaults to `4` |
| `--timeout` | number | No | Workflow timeout in ms. Defaults to `3_600_000` (1 hour) |

### Persona resolution

The `--agent` value resolves through a two-step lookup:

```
--agent <value>
  1. Try personaCatalog lookup by intent: personaCatalog[value]
  2. Try reverse lookup by persona ID: find spec where spec.id === value
  3. If neither matches, exit with error listing valid values
```

Concrete resolution map (both columns are valid `--agent` values):

| `--agent` value (by ID) | `--agent` value (by intent) | Resolved intent |
|---|---|---|
| `frontend-implementer` | `implement-frontend` | `implement-frontend` |
| `code-reviewer` | `review` | `review` |
| `architecture-planner` | `architecture-plan` | `architecture-plan` |
| `requirements-analyst` | `requirements-analysis` | `requirements-analysis` |
| `debugger` | `debugging` | `debugging` |
| `security-reviewer` | `security-review` | `security-review` |
| `technical-writer` | `documentation` | `documentation` |
| `verifier` | `verification` | `verification` |
| `test-strategist` | `test-strategy` | `test-strategy` |
| `tdd-guard` | `tdd-enforcement` | `tdd-enforcement` |
| `flake-hunter` | `flake-investigation` | `flake-investigation` |
| `opencode-workflow-specialist` | `opencode-workflow-correctness` | `opencode-workflow-correctness` |
| `npm-provenance-publisher` | `npm-provenance` | `npm-provenance` |

Implementation: build a `personaIdToIntent` reverse map at SDK init time by iterating `personaCatalog` entries.

### How the task description influences generation

The task description string is used in three places:

1. **Workflow name**: Slugified to become the workflow ID (e.g. `"configure trusted publishing"` -> `configure-trusted-publishing`)
2. **Agent task prompt**: Injected as the primary instruction to the agent, combined with the persona's `systemPrompt` and any context file outputs
3. **Workflow description**: Used as the `.description()` value on the generated workflow

The task description is **not** parsed for semantic meaning to influence step generation. Pattern selection and verification gates are driven by the persona's declared capabilities (intent, skills, preset mapping), not by NLP on the task string. This keeps the system deterministic and debuggable.

---

## Workflow Generator

### Architecture

The generator is a pure function that takes a `WorkflowGeneratorInput` and returns a `WorkflowDefinition` (the chain of `.step()` / `.agent()` calls serialized as a data structure). Execution is a separate step.

```
                          ┌─────────────────────┐
  CLI args ───────────────► resolveAgentFlag()   │
  (task, --agent, etc.)   │  - persona lookup    │
                          │  - tier selection     │
                          │  - skill plan         │
                          └──────────┬────────────┘
                                     │ WorkflowGeneratorInput
                                     ▼
                          ┌─────────────────────┐
                          │ generateWorkflow()   │
                          │  - pattern selection  │
                          │  - step assembly      │
                          │  - template rendering │
                          └──────────┬────────────┘
                                     │ WorkflowDefinition
                                     ▼
                          ┌─────────────────────┐
                          │ executeWorkflow()    │  (existing agent-relay runtime)
                          └─────────────────────┘
```

### Input interface

```ts
interface WorkflowGeneratorInput {
  // From CLI parsing
  taskDescription: string;
  workflowName: string;          // slugified from taskDescription

  // From persona resolution
  persona: PersonaSpec;
  selection: PersonaSelection;   // includes tier, runtime, skills
  skillPlan: SkillMaterializationPlan;

  // From CLI flags or defaults
  contextFiles: ContextFileSpec[];
  verifications: VerificationSpec[];
  outputFile?: string;
  maxConcurrency: number;        // default: 4
  timeout: number;               // default: 3_600_000
}

interface ContextFileSpec {
  stepName: string;              // e.g. 'read-publish-yml'
  command: string;               // e.g. 'cat .github/workflows/publish.yml'
}

interface VerificationSpec {
  stepName: string;              // e.g. 'verify-no-npm-token'
  command: string;               // e.g. 'grep -q ...'
}
```

### Template engine: skeleton + persona-specific parts

The generator assembles the workflow by emitting phases in order. Each phase is a function that appends steps to the workflow builder:

```ts
function generateWorkflow(input: WorkflowGeneratorInput): WorkflowDefinition {
  const builder = workflow(input.workflowName)
    .description(input.taskDescription)
    .pattern(selectPattern(input))
    .channel(`wf-${input.workflowName}`)
    .maxConcurrency(input.maxConcurrency)
    .timeout(input.timeout);

  // Emit agents
  emitAgentDefinitions(builder, input);

  // Phase A: Bootstrap (always emitted)
  emitBootstrapPhase(builder);

  // Phase B: Skill materialization (conditional)
  if (input.skillPlan.installs.length > 0) {
    emitSkillPhase(builder, input);
  }

  // Phase C: Context gathering (from CLI --context flags or defaults)
  emitContextPhase(builder, input);

  // Phase D: Agent execution
  emitTaskPhase(builder, input);

  // Phase E: Verification gates (from CLI --verify flags or defaults)
  emitVerificationPhase(builder, input);

  // Phase F: Final guardrail (always emitted)
  emitFinalPhase(builder, input);

  return builder.onError('fail-fast');
}
```

### Pattern selection logic

```
selectPattern(input):
  intent = input.persona.intent

  // Explicitly sequential intents -> pipeline
  if intent in ['requirements-analysis', 'documentation', 'tdd-enforcement']:
    return 'pipeline'

  // Everything else -> dag (enables parallel context reads + skill install)
  return 'dag'
```

The DAG pattern is the default because:
- Context gathering steps run in parallel with each other
- Skill installation runs in parallel with context reads (different dependency chains)
- Verification gates run in parallel after the agent step

Pipeline is only used when the task is inherently sequential with no opportunity for parallelism. In practice, even pipeline-intent workflows benefit from DAG when they have context reads, so DAG is the safe universal default.

Fan-out and hub-spoke are future optimizations for multi-file or multi-subsystem tasks. They are not needed for v1.

### Step generation rules

| Condition | Steps emitted |
|---|---|
| Always | `install-deps`, `build-sdk` |
| `skillPlan.installs.length > 0` | `plan-skills`, `install-skills`, `verify-skill-installed` |
| `contextFiles.length > 0` | One `read-<name>` step per context file |
| Always | One agent execution step (`execute-task`) |
| `verifications.length > 0` | One verification step per entry |
| `outputFile` is set | Additional `verify-output-exists` step |
| Always | `check` (checker agent), `git-status` |

### Agent definition rules

**Primary agent:**
```ts
.agent('executor', {
  cli: selection.runtime.harness,              // from persona tier
  preset: derivePreset(persona.intent),        // 'worker' or 'analyst'
  role: shortenDescription(persona.description),
  retries: deriveRetries(persona.intent)       // 2 for workers, 1 for analysts
})
```

**Checker agent (invariant):**
```ts
.agent('checker', {
  cli: 'codex',
  preset: 'worker',
  role: 'Runs pnpm run check and reports failures verbatim',
  retries: 1
})
```

**Preset derivation:**

| Intent | Preset | Rationale |
|---|---|---|
| `implement-frontend` | `worker` | Modifies UI code |
| `review` | `analyst` | Read-only analysis |
| `architecture-plan` | `analyst` | Produces plans, not code |
| `requirements-analysis` | `analyst` | Read-only analysis |
| `debugging` | `worker` | Modifies code to fix bugs |
| `security-review` | `analyst` | Read-only analysis |
| `documentation` | `worker` | Creates/modifies doc files |
| `verification` | `analyst` | Read-only evidence checking |
| `test-strategy` | `analyst` | Produces strategy, not code |
| `tdd-enforcement` | `worker` | May create/modify test files |
| `flake-investigation` | `worker` | Modifies code to fix flakes |
| `opencode-workflow-correctness` | `worker` | Modifies config/code |
| `npm-provenance` | `worker` | Modifies workflow/config files |

---

## Pattern Selection Matrix

| Intent | Pattern | Reasoning |
|---|---|---|
| `implement-frontend` | **DAG** | Parallel context reads (component files, design patterns, existing styles), then sequential implementation. Multiple verification gates (build, a11y, tests) run in parallel after task. |
| `review` | **DAG** | Read git diff + changed files in parallel, then sequential review analysis. Simple enough for pipeline but DAG enables parallel pre-reads. |
| `architecture-plan` | **DAG** | Parallel reads of multiple codebase areas (dependency graph, existing docs, relevant source dirs), convergent analysis. |
| `requirements-analysis` | **Pipeline** | Fundamentally sequential: read input -> analyze -> produce requirements -> verify. Minimal parallel pre-work opportunity. |
| `debugging` | **DAG** | Parallel evidence gathering (error logs, stack traces, git diffs, test output), then convergent root-cause analysis. Multiple verification reruns possible. |
| `security-review` | **DAG** | Parallel reads of trust boundaries, auth paths, input handling code. Convergent threat analysis. |
| `documentation` | **Pipeline** | Sequential: read code -> write docs -> verify accuracy. Minimal parallelism opportunity. |
| `verification` | **DAG** | Parallel checking of multiple acceptance criteria. Each criterion is independently verifiable, results converge to verdict. |
| `test-strategy` | **DAG** | Parallel reads of changed code + existing test files, convergent strategy synthesis. |
| `tdd-enforcement` | **Pipeline** | Inherently sequential red-green-refactor cycles. Each cycle depends on the previous. |
| `flake-investigation` | **DAG** | Parallel reproduction runs + log analysis, convergent root-cause identification. |
| `opencode-workflow-correctness` | **DAG** | Parallel layer inspection (SDK source, broker logs, CLI config, bootstrap state), convergent diagnosis. |
| `npm-provenance` | **DAG** | Proven pattern from existing workflows. Parallel reads + skill install, convergent task execution, parallel verification gates. |

**Summary:** DAG is the default for 10/13 intents. Pipeline is used for 3 inherently sequential intents. All existing production workflows use DAG.

---

## Generated Workflow Structure

### Canonical step ordering

```
PHASE A: BOOTSTRAP (always present, deterministic)
┌─────────────────────────────────────────────────────────────────┐
│ install-deps        corepack pnpm install --frozen-lockfile     │
│   └── build-sdk     corepack pnpm --filter                     │
│                       @agentworkforce/workload-router run build │
└─────────────────────────────────────────────────────────────────┘

PHASE B: SKILL MATERIALIZATION (conditional: persona.skills.length > 0)
┌─────────────────────────────────────────────────────────────────┐
│ plan-skills          node -e "resolvePersona + materialize..."  │
│   └── install-skills node -e "spawnSync each install command"   │
│     └── verify-skill test -f <installedManifest>                │
└─────────────────────────────────────────────────────────────────┘

PHASE C: CONTEXT GATHERING (parallel, deterministic)
┌─────────────────────────────────────────────────────────────────┐
│ read-<context-1>    cat <file-1>          (captureOutput: true) │
│ read-<context-2>    cat <file-2>          (captureOutput: true) │
│ ...                                                             │
└─────────────────────────────────────────────────────────────────┘

PHASE D: TASK EXECUTION (agent step)
┌─────────────────────────────────────────────────────────────────┐
│ execute-task         agent: 'executor'                          │
│   dependsOn: [verify-skill-installed?, read-<ctx>...]           │
│   task: taskPrompt + {{steps.read-<ctx>.output}} interpolation  │
│   verification: { type: 'exit_code' }                          │
│   retries: 1-2                                                  │
└─────────────────────────────────────────────────────────────────┘

PHASE E: VERIFICATION GATES (parallel, deterministic)
┌─────────────────────────────────────────────────────────────────┐
│ verify-<check-1>    grep/test assertion   dependsOn: [task]     │
│ verify-<check-2>    ...                   dependsOn: [task]     │
│ verify-output       test -f <outputFile>  dependsOn: [task]     │
└─────────────────────────────────────────────────────────────────┘

PHASE F: FINAL GUARDRAIL (always present)
┌─────────────────────────────────────────────────────────────────┐
│ check               agent: 'checker'                            │
│                     dependsOn: [all verify-* steps]             │
│                     task: 'corepack pnpm run check'             │
│   └── git-status    git status --short && git diff --stat       │
│                     captureOutput: true, failOnError: false      │
└─────────────────────────────────────────────────────────────────┘
```

### DAG dependency edges

```
install-deps ──► build-sdk ──► plan-skills ──► install-skills ──► verify-skill-installed ──┐
                                                                                            │
read-context-1 ────────────────────────────────────────────────────────────────────────────►├──► execute-task
read-context-2 ────────────────────────────────────────────────────────────────────────────►│
                                                                                            │
                    execute-task ──► verify-check-1 ──┐                                     
                    execute-task ──► verify-check-2 ──├──► check ──► git-status
                    execute-task ──► verify-output  ──┘
```

When skills are absent, `execute-task` depends directly on `build-sdk` + all `read-*` steps.

### Verification gate selection per persona type

The generator selects default verification gates based on the persona's behavioral category:

| Persona category | Intents | Default verification gates |
|---|---|---|
| **Implementers** | `implement-frontend`, `npm-provenance` | File modification checks: grep for expected content in target files, negative greps for removed patterns, JSON field existence checks, build validation |
| **Reviewers** | `review`, `security-review` | Output existence: `test -f <review-output>`, optionally grep for structured sections (## Findings, ## Risk) |
| **Analysts** | `requirements-analysis`, `test-strategy`, `architecture-plan` | Output existence: `test -f <analysis-output>`, optionally grep for expected sections |
| **Debuggers** | `debugging`, `flake-investigation`, `opencode-workflow-correctness` | Re-execution: rerun the failing scenario to verify the fix, exit code check |
| **Process enforcers** | `tdd-enforcement`, `verification` | Evidence freshness: verify test output exists and is current, verify claims match evidence |
| **Writers** | `documentation` | Output existence + accuracy: `test -f <docs-output>`, verify code references are valid links |

When `--verify` flags are provided on the CLI, they replace the defaults. When `--output` is provided, a `verify-output-exists` gate is always added regardless of persona type.

### Task prompt assembly

The task prompt for the agent execution step is assembled from three parts:

```
[SKILL PREAMBLE — only if persona has skills]
Apply the <skill-id> skill (already installed at <skill-path>) to <task>.

[CONTEXT INJECTION — one block per context file]
Current <filename>:
{{steps.read-<context>.output}}

[TASK BODY — the user's task description + constraints]
<task-description>

IMPORTANT: <scope constraints based on preset>
```

**Scope constraints by preset:**
- `worker`: "Write the output to disk. Only modify <target files>. Do NOT touch any other file."
- `analyst`: "Write your analysis to <output-path>. Do NOT modify any source files."

---

## Implementation Plan

### Phase 1: Core infrastructure (workload-router SDK)

**Task 1.1: Add persona ID reverse-lookup to the SDK**

File: `packages/workload-router/src/index.ts`

Add a `personaIdToIntent` map and a `resolvePersonaByIdOrIntent()` function:

```ts
// Build reverse map: persona ID -> intent
export const personaIdToIntent: ReadonlyMap<string, PersonaIntent> = new Map(
  PERSONA_INTENTS.map(intent => [personaCatalog[intent].id, intent])
);

export function resolvePersonaByIdOrIntent(
  ref: string,
  profile: RoutingProfile | RoutingProfileId = 'default'
): PersonaSelection {
  // Try as intent first
  if (isIntent(ref)) {
    return resolvePersona(ref, profile);
  }
  // Try as persona ID
  const intent = personaIdToIntent.get(ref);
  if (intent) {
    return resolvePersona(intent, profile);
  }
  throw new Error(
    `Unknown persona reference: "${ref}". ` +
    `Valid intents: ${PERSONA_INTENTS.join(', ')}. ` +
    `Valid IDs: ${[...personaIdToIntent.keys()].join(', ')}.`
  );
}
```

**Task 1.2: Add preset derivation to the SDK**

File: `packages/workload-router/src/index.ts`

```ts
const ANALYST_INTENTS: ReadonlySet<PersonaIntent> = new Set([
  'review', 'architecture-plan', 'requirements-analysis',
  'security-review', 'verification', 'test-strategy'
]);

export function derivePreset(intent: PersonaIntent): 'worker' | 'analyst' {
  return ANALYST_INTENTS.has(intent) ? 'analyst' : 'worker';
}
```

**Task 1.3: Export pattern selection from the SDK**

File: `packages/workload-router/src/index.ts`

```ts
const PIPELINE_INTENTS: ReadonlySet<PersonaIntent> = new Set([
  'requirements-analysis', 'documentation', 'tdd-enforcement'
]);

export function derivePattern(intent: PersonaIntent): 'dag' | 'pipeline' {
  return PIPELINE_INTENTS.has(intent) ? 'pipeline' : 'dag';
}
```

### Phase 2: Workflow generator module

**Task 2.1: Create the generator module**

File: `packages/workload-router/src/workflow-generator.ts`

This module exports a `generateWorkflow()` function that takes a `WorkflowGeneratorInput` and returns a serialized workflow definition (the chained `.step()` / `.agent()` calls as a JavaScript/TypeScript string).

Key functions:
- `generateWorkflow(input: WorkflowGeneratorInput): string` — main entry point, returns a complete `.ts` workflow file as a string
- `emitBootstrapPhase(): StepDef[]` — always returns `install-deps` + `build-sdk`
- `emitSkillPhase(intent: PersonaIntent): StepDef[]` — returns `plan-skills`, `install-skills`, `verify-skill-installed` with the intent string templated in
- `emitContextPhase(contextFiles: ContextFileSpec[]): StepDef[]` — returns one `read-*` step per file
- `emitTaskPhase(input): StepDef` — assembles the agent execution step with prompt, dependencies, and verification
- `emitVerificationPhase(verifications: VerificationSpec[]): StepDef[]` — returns verification gate steps
- `emitFinalPhase(): StepDef[]` — returns `check` + `git-status`

The generator outputs a complete CJS workflow file string that can be:
1. Written to a temp file and executed via the existing `agent-relay run <file>` path
2. Printed to stdout with `--dry-run`
3. Executed in-memory via the workflow builder API

**Task 2.2: Build the task prompt assembler**

File: `packages/workload-router/src/workflow-generator.ts` (same module)

Assembles the multi-line task prompt from:
- Skill preamble (conditional on `skillPlan.installs.length > 0`)
- Context injection blocks (one per `contextFile`, referencing `{{steps.read-<name>.output}}`)
- Task body (the user's task description)
- Scope constraints (derived from preset)

### Phase 3: CLI integration

**Task 3.1: Add `--agent` flag parsing to the CLI**

File: agent-relay CLI entry point (likely `packages/agent-relay/src/cli.ts` or equivalent)

When `--agent` is present:
1. Call `resolvePersonaByIdOrIntent(agentFlag, profileFlag)` to get `PersonaSelection`
2. Call `materializeSkillsFor(selection)` to get `SkillMaterializationPlan`
3. Build `WorkflowGeneratorInput` from CLI args + resolved persona
4. Call `generateWorkflow(input)` to produce the workflow definition
5. If `--dry-run`: print the generated workflow to stdout and exit
6. Otherwise: write to a temp file and execute via existing `agent-relay run` machinery

**Task 3.2: Default context file heuristics**

When `--context` is not provided, apply intent-based defaults:

| Intent | Default context commands |
|---|---|
| `review`, `security-review` | `git diff HEAD~1`, `git diff --name-only HEAD~1` |
| `debugging`, `flake-investigation` | `git diff HEAD~1`, `git log --oneline -5` |
| `implement-frontend` | (none — user must provide `--context`) |
| `architecture-plan` | `ls -la packages/`, `cat package.json` |
| `npm-provenance` | `cat .github/workflows/publish.yml`, `cat package.json` |
| All others | `git status --short` |

These are overridden entirely when `--context` is specified.

### Phase 4: Testing

**Task 4.1: Unit tests for persona resolution**

File: `packages/workload-router/src/index.test.ts`

- Test `resolvePersonaByIdOrIntent()` with all 13 persona IDs
- Test `resolvePersonaByIdOrIntent()` with all 13 intents
- Test error case with invalid ref
- Test `derivePreset()` for each intent
- Test `derivePattern()` for each intent

**Task 4.2: Unit tests for workflow generator**

File: `packages/workload-router/src/workflow-generator.test.ts`

- Test `generateWorkflow()` with a skill-bearing persona (npm-provenance) — verify skill phase is present
- Test `generateWorkflow()` with a skillless persona (security-reviewer) — verify skill phase is absent
- Test that context files produce `read-*` steps with `captureOutput: true`
- Test that verifications produce deterministic steps with `failOnError: true`
- Test that the checker agent is always present
- Test that `--dry-run` output is valid JavaScript (eval or syntax check)
- Snapshot tests comparing generated output against the hand-written `configure-trusted-publishing.ts` and `finish-npm-provenance-persona.ts` (the generated versions should be structurally equivalent)

**Task 4.3: Integration test**

File: `packages/workload-router/src/workflow-generator.integration.test.ts`

- End-to-end test: parse CLI args -> resolve persona -> generate workflow -> validate structure
- Test with `--dry-run` flag to verify output without execution

### Phase 5: Documentation and migration

**Task 5.1: Update SDK exports**

File: `packages/workload-router/src/index.ts`

Export new functions: `resolvePersonaByIdOrIntent`, `derivePreset`, `derivePattern`, `generateWorkflow`

**Task 5.2: Add `--agent` flag documentation**

Add usage examples to the repo README or CLI help text showing the three main use cases:
1. Basic: `agent-relay run "task" --agent <persona>`
2. With context: `agent-relay run "task" --agent <persona> --context file1 --context file2`
3. Dry run: `agent-relay run "task" --agent <persona> --dry-run`

### Implementation order

| # | Task | Depends on | Files |
|---|---|---|---|
| 1 | Persona ID reverse-lookup | — | `packages/workload-router/src/index.ts` |
| 2 | Preset + pattern derivation | — | `packages/workload-router/src/index.ts` |
| 3 | Unit tests for 1 + 2 | 1, 2 | `packages/workload-router/src/index.test.ts` |
| 4 | Workflow generator module | 1, 2 | `packages/workload-router/src/workflow-generator.ts` |
| 5 | Task prompt assembler | 4 | `packages/workload-router/src/workflow-generator.ts` |
| 6 | Generator unit tests | 4, 5 | `packages/workload-router/src/workflow-generator.test.ts` |
| 7 | CLI `--agent` flag parsing | 4 | agent-relay CLI entry point |
| 8 | Default context heuristics | 7 | agent-relay CLI entry point |
| 9 | Integration tests | 7, 8 | `packages/workload-router/src/workflow-generator.integration.test.ts` |
| 10 | Documentation | 7 | README / CLI help |

### Key design decisions

1. **Generator output is a `.ts` file string, not an in-memory object.** This means `--dry-run` produces a human-readable, auditable workflow that can be saved and re-executed. It also means the generator reuses the existing `agent-relay run <file>` execution path with zero new runtime code.

2. **Pattern selection is intent-based, not NLP-based.** The persona's intent deterministically selects the pattern. This is predictable and testable. Future versions could add task-description heuristics, but v1 keeps it simple.

3. **The skill materialization pipeline is templated, not hard-coded.** The `plan-skills` and `install-skills` steps use the same `node -e` one-liner pattern from existing workflows, parameterized only by the persona intent string. The `verify-skill-installed` path is derived from `materializeSkillsFor()` output, not hard-coded per harness.

4. **Verification gates have sensible defaults but are fully overridable.** Each persona type gets default verification gates (see the persona category table above). The `--verify` and `--output` CLI flags add or replace gates. This balances zero-config usability with power-user control.

5. **The checker agent always uses `codex`.** It runs a deterministic shell command (`pnpm run check`), so it doesn't need the persona's model or harness. Using `codex` keeps it consistent and cost-effective.
