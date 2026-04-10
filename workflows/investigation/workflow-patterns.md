# Workflow Pattern Analysis

Extracted from the three hand-written workflows in `workflows/` and cross-referenced with
the workload-router SDK (`packages/workload-router/src/index.ts`), 13 persona definitions
(`personas/*.json`), the default routing profile (`routing-profiles/default.json`), and the
GitHub Actions publish workflow (`.github/workflows/publish.yml`).

Source workflows:
- `configure-trusted-publishing.ts` — rewrites an existing publish.yml for OIDC
- `finish-npm-provenance-persona.ts` — creates a new publish workflow from scratch
- `investigate-agent-profile-workflows.ts` — multi-phase research/generation task

---

## 1. COMMON SKELETON

Every workflow follows the same six-phase DAG spine. The number of steps in each phase
varies, but the phases and their ordering are invariant across all three workflows.

| Phase | Purpose | Step type | Present in all 3? |
|---|---|---|---|
| **A. Bootstrap** | Install deps + build SDK | `deterministic` | Yes |
| **B. Skill materialization** | Resolve persona -> plan -> install -> verify skills | `deterministic` | Conditional (2 of 3; skip when `persona.skills.length === 0`) |
| **C. Context gathering** | Read files needed by agent task(s) | `deterministic` + `captureOutput` | Yes |
| **D. Agent execution** | Core task -- agent writes/creates/analyzes files | `agent` step | Yes |
| **E. Verification gates** | Deterministic checks that the output is correct | `deterministic` | Yes |
| **F. Final guardrail** | `pnpm run check` via checker agent + optional git diff/status | `agent` + `deterministic` | Yes |

### Canonical DAG shape

```
install-deps
  |
  v
build-sdk
  |
  +---> plan-skills --> install-skills --> verify-skill-installed --+
  |                                                                 |
  |   read-context-1 (parallel) -----------------------------------+---> AGENT EXECUTION
  |   read-context-2 (parallel) -----------------------------------+
  |   read-context-N (parallel) -----------------------------------+
  |                                                                       |
  |                                                      verification-gate-1 --+
  |                                                      verification-gate-2 --+--> checker (pnpm run check)
  |                                                      verification-gate-N --+           |
  |                                                                                        v
  |                                                                                git-diff / git-status
```

Key structural observations:
- Context reads run **in parallel** with each other and with the skill materialization chain
- Agent execution **depends on** both the skill-install gate AND all context reads
- Verification gates depend only on the agent execution step
- The checker agent depends on all verification gates
- git-diff/status is purely informational (`failOnError: false`)

### Phase A: Bootstrap (invariant)

```ts
.step('install-deps', {
  type: 'deterministic',
  command: 'corepack pnpm install',          // or --frozen-lockfile variant
  failOnError: true
})

.step('build-sdk', {
  type: 'deterministic',
  dependsOn: ['install-deps'],
  command: 'corepack pnpm --filter @agentworkforce/workload-router run build',
  failOnError: true
})
```

**Variable part**: `--frozen-lockfile` flag. Present in `finish-npm-provenance-persona.ts`,
absent in `configure-trusted-publishing.ts`. A generator should default to `--frozen-lockfile`
for reproducibility and allow override.

### Phase B: Skill materialization (conditional on `persona.skills.length > 0`)

Four deterministic steps using the SDK's `resolvePersona()` and `materializeSkillsFor()`:

```ts
// 1. Plan: resolve persona and print install commands
.step('plan-skills', {
  type: 'deterministic',
  dependsOn: ['build-sdk'],
  command: /* node -e calling resolvePersona('<INTENT>') + materializeSkillsFor() */,
  captureOutput: true,
  failOnError: true
})

// 2. Install: execute the prpm install commands via spawnSync
.step('install-skills', {
  type: 'deterministic',
  dependsOn: ['plan-skills'],
  command: /* node -e calling resolvePersona('<INTENT>') + materializeSkillsFor() + spawnSync */,
  failOnError: true
})

// 3. Verify: check the skill directory/manifest exists on disk
.step('verify-skill-installed', {
  type: 'deterministic',
  dependsOn: ['install-skills'],
  command: /* test -d or test -f on expected skill path */,
  failOnError: true
})
```

**Variable parts**:

| Variable | Source | Example values |
|---|---|---|
| Persona intent string | Task input | `'npm-provenance'` |
| Skill install directory | `HARNESS_SKILL_TARGETS[harness].dir` | `.claude/skills`, `.opencode/skills`, `.agents/skills` |
| Verification path | Derived from `materializeSkills()` | `.claude/skills/npm-trusted-publishing/SKILL.md` |
| Verify command style | Convention varies | `test -d` (directory check) or `test -f ... /SKILL.md` (manifest check) |

**Key insight**: The `plan-skills` and `install-skills` node one-liners are **identical** across
`configure-trusted-publishing.ts` and `finish-npm-provenance-persona.ts`. Only the persona
intent string differs. The SDK's `materializeSkillsFor()` handles all harness-specific logic
(`.claude/skills/` vs `.opencode/skills/` vs `.agents/skills/`), making these steps a pure
template target.

**Harness-to-skill-directory mapping** (from `HARNESS_SKILL_TARGETS` in the SDK):

| Harness | `--as` flag | Skill directory |
|---|---|---|
| `claude` | `claude` | `.claude/skills/<name>` |
| `codex` | `codex` | `.agents/skills/<name>` |
| `opencode` | `opencode` | `.opencode/skills/<name>` |

Personas without skills (e.g. `code-reviewer`, `security-reviewer`, `test-strategist`,
`verifier`, `frontend-implementer`, `debugger`, `architecture-planner`, `requirements-analyst`,
`technical-writer`, `tdd-guard`, `flake-hunter`, `opencode-workflow-specialist`) skip this
entire phase. Currently only `npm-provenance-publisher` declares skills.

### Phase C: Context gathering (task-specific)

Each workflow reads different files. The universal pattern is:

```ts
.step('read-<name>', {
  type: 'deterministic',
  command: 'cat <file-path>',        // or shell loop, git command, etc.
  captureOutput: true,
  failOnError: true
})
```

Context read steps run in parallel with no inter-dependencies. Their outputs are injected
into agent task prompts via `{{steps.read-<name>.output}}`.

**Observed command patterns**:

| Pattern | Example | Used in |
|---|---|---|
| Single file read | `cat .github/workflows/publish.yml` | configure-trusted-publishing, finish-npm-provenance |
| Glob loop | `for f in personas/*.json; do echo "=== $f ==="; cat "$f"; echo; done` | investigate |
| Multi-file loop | `for f in workflows/*.ts; do ...` | investigate |

**Variable parts**: The list of `{ stepName, command }` entries is entirely task-specific.
The generator needs to accept this as input.

### Phase D: Agent execution (core task)

```ts
.step('<task-name>', {
  agent: '<agent-id>',
  dependsOn: ['verify-skill-installed', 'read-context-1', ...],
  task: `<multi-line prompt with {{steps.X.output}} interpolation>`,
  verification: { type: 'exit_code' },    // or { type: 'file_exists', value: '<path>' }
  retries: 2
})
```

**Variable parts**:
- Agent id (maps to `.agent()` definition)
- `dependsOn` list: skill-verify gate (if skills present) + all context-read step ids
- Task prompt (fully task-specific, but follows a template -- see Section 4)
- Verification type: `exit_code` (default) or `file_exists` (document generation)
- Retry count: 1-2 for primary agents

The investigation workflow has **multiple parallel agent execution steps** across phases.
The simpler workflows have exactly one. A generator should support both patterns: single-agent
and multi-agent fan-out.

### Phase E: Verification gates (task-specific)

Deterministic steps that `dependsOn` the agent execution step. Five distinct patterns
observed:

| Pattern | Shell template | When to use |
|---|---|---|
| **Negative grep** | `if grep -q "<BAD>" <FILE>; then exit 1; fi` | Ensuring something was _removed_ |
| **Positive grep** | `grep -q "<GOOD>" <FILE> && echo OK \|\| exit 1` | Ensuring something was _added_ |
| **File existence** | `test -f <PATH> && echo OK \|\| exit 1` | File was created |
| **JSON field check** | `node -e "const p=require('./<PKG>');if(!p.<FIELD>)...exit(1)"` | package.json updated |
| **Batch file check** | `for f in <LIST>; do test -f "$f" \|\| missing++; done` | Multi-file output |

**Variable parts**: The specific assertions. Entirely determined by task requirements.

### Phase F: Final guardrail (nearly invariant)

```ts
.step('check', {
  agent: 'checker',
  dependsOn: [/* all verification gates */],
  task: 'Run `corepack pnpm run check` from the repo root. Report the full stderr/stdout of any failing command verbatim. Do not attempt fixes; just report. If everything passes, print the final "check" summary.',
  verification: { type: 'exit_code' }
})

.step('git-diff', {                         // or 'git-status'
  type: 'deterministic',
  dependsOn: ['check'],
  command: 'git diff <target-file>',         // or 'git status --short && git diff --stat'
  captureOutput: true,
  failOnError: false                         // always false -- informational
})
```

**Variable parts**:
- `git diff <file>` for file-modifying tasks vs. `git status --short && git diff --stat` for file-creating tasks
- The specific target file(s) in the diff command

---

## 2. AGENT CONFIGURATION

### Agent definition shape

Every workflow defines agents with the same interface:

```ts
.agent('<id>', {
  cli: '<harness>',       // 'claude' | 'codex' | 'opencode'
  preset: '<preset>',     // 'worker' | 'analyst'
  role: '<description>',
  retries: <N>
})
```

### Deriving agent config from persona resolution

The persona's **resolved tier** (from the routing profile) determines the runtime, which
provides the harness:

```ts
const selection = resolvePersona(intent, 'default');
// selection.runtime.harness => the CLI to use
// selection.runtime.model => the model (not used directly in agent def, but informs capability)
// selection.runtime.harnessSettings.reasoning => low|medium|high
// selection.runtime.harnessSettings.timeoutSeconds => per-agent timeout
```

**Harness -> CLI mapping** (direct 1:1):

| `selection.runtime.harness` | Agent `cli` value |
|---|---|
| `codex` | `'codex'` |
| `opencode` | `'opencode'` |
| `claude` | `'claude'` |

**Persona tier -> typical harness** (from actual persona definitions):

| Tier | Typical harness | Exceptions |
|---|---|---|
| `best` | `codex` | All 13 personas use `codex` for `best` |
| `best-value` | `opencode` | `npm-provenance-publisher` uses `opencode` (note: `finish-npm-provenance-persona.ts` overrides to `claude` -- likely a pre-routing-profile artifact) |
| `minimum` | `opencode` | All 13 personas use `opencode` for `minimum` |

### Preset selection heuristic

Two presets observed:

| Preset | Used for | Intent categories |
|---|---|---|
| `worker` | Task execution (writing code, creating files, modifying configs) | `implement-frontend`, `npm-provenance`, `debugging`, `tdd-enforcement`, `flake-investigation`, `opencode-workflow-correctness` |
| `analyst` | Read-only analysis, investigation, review | `review`, `security-review`, `test-strategy`, `verification`, `architecture-plan`, `requirements-analysis`, `documentation` |

**Derivation rule**: If the persona's intent typically _modifies or creates_ files, use
`worker`. If it _analyzes or reviews_ without expected file mutation, use `analyst`.

### The checker agent is universal and invariant

```ts
.agent('checker', {
  cli: 'codex',
  preset: 'worker',
  role: 'Runs pnpm run check and reports failures verbatim',
  retries: 1
})
```

Always `codex`, always `worker`, always `retries: 1`. The generator should emit this
unconditionally.

### Role string derivation

The role string for the primary agent is a short phrase derived from the persona's description
or systemPrompt:

| Persona ID | `persona.description` | Agent `role` in workflow |
|---|---|---|
| `npm-provenance-publisher` | "Sets up and verifies secure npm publishing via GitHub Actions OIDC..." | `'npm trusted publishing implementer'` |
| `code-reviewer` | "Reviews pull requests for correctness, risk, and maintainability." | (projected) `'Code reviewer for correctness, risk, and maintainability'` |
| `security-reviewer` | "Reviews code and plans for exploitable security risks..." | (projected) `'Security reviewer for exploitable risks and defensive controls'` |

**Generator approach**: Truncate `persona.description` to first clause or derive a
~5-10 word action phrase.

### Multi-agent workflows

The investigation workflow demonstrates a pattern with 3+ agents:

```ts
.agent('analyst', { cli: 'claude', preset: 'analyst', role: '...', retries: 1 })
.agent('planner', { cli: 'claude', preset: 'worker', role: '...', retries: 2 })
.agent('generator', { cli: 'codex', preset: 'worker', role: '...', retries: 2 })
```

In this case, different phases of the workflow use different agents with different
capabilities. A generator for complex tasks should support declaring multiple agents
and assigning them to specific steps.

---

## 3. VERIFICATION PATTERNS

### Verification strategy by task category

| Task category | Example personas | Verification gates | Agent verification type |
|---|---|---|---|
| **File modification** (rewrite existing) | `npm-provenance` (configure-trusted-publishing) | Negative greps (removed patterns), positive greps (required patterns), JSON field checks | `exit_code` |
| **File creation** (create new) | `npm-provenance` (finish-npm-provenance-persona) | File existence + positive greps + JSON field checks | `exit_code` |
| **Analysis/document generation** | `security-review`, `review`, `test-strategy`, `architecture-plan` | File existence checks (batch or individual) | `file_exists` |
| **Code implementation** | `implement-frontend`, `debugging` | Test execution, lint pass, build success | `exit_code` |
| **Verification/audit** | `verification` | Exit code only (the verifier's output IS the verification) | `exit_code` |

### Verification gate templates

**For file-modifying tasks** (most verification-heavy):

```ts
// Ensure a pattern was REMOVED
.step('verify-no-<pattern>', {
  type: 'deterministic',
  dependsOn: ['<agent-step>'],
  command: 'if grep -q "<BAD_PATTERN>" <TARGET_FILE>; then echo "FAIL: still references <BAD_PATTERN>" >&2; exit 1; fi; echo "OK: no <BAD_PATTERN> found"',
  failOnError: true
})

// Ensure a pattern was ADDED
.step('verify-<feature>', {
  type: 'deterministic',
  dependsOn: ['<agent-step>'],
  command: 'grep -q "<REQUIRED_PATTERN>" <TARGET_FILE> && echo "OK: <REQUIRED_PATTERN> present" || (echo "FAIL: missing <REQUIRED_PATTERN>" >&2; exit 1)',
  failOnError: true
})

// Ensure a JSON field exists
.step('verify-<field>', {
  type: 'deterministic',
  dependsOn: ['<agent-step>'],
  command: "node -e \"const p=require('./<PKG_JSON>');if(!p.<FIELD>){console.error('<FIELD> missing');process.exit(1)}console.log('OK:', p.<FIELD>)\"",
  failOnError: true
})
```

**For file-creating tasks**:

```ts
// Ensure file exists + has required content
.step('verify-<output>', {
  type: 'deterministic',
  dependsOn: ['<agent-step>'],
  command: 'test -f <OUTPUT_PATH> && grep -q "<REQUIRED>" <OUTPUT_PATH> && echo "OK"',
  failOnError: true
})
```

**For analysis/document tasks** (minimal verification):

```ts
// Batch file existence check
.step('verify-outputs', {
  type: 'deterministic',
  dependsOn: [/* all agent steps */],
  command: [
    'missing=0',
    'for f in <FILE_1> <FILE_2> <FILE_N>; do',
    '  if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi',
    'done',
    'if [ $missing -gt 0 ]; then echo "$missing files missing"; exit 1; fi',
    'echo "All outputs present"'
  ].join('; '),
  failOnError: true
})
```

### Agent-step verification types

| Type | Usage | Example |
|---|---|---|
| `{ type: 'exit_code' }` | Agent succeeds if CLI exits 0 | Default for code/config tasks |
| `{ type: 'file_exists', value: '<path>' }` | Agent succeeds if file was created | Used in investigation for document generation |

---

## 4. TASK PROMPT TEMPLATES

### Universal prompt structure

Every agent task prompt follows this four-part structure:

```
1. CONTEXT HEADER    -- what skill/capability to use, with location on disk
2. INJECTED DATA     -- previous step outputs via {{steps.X.output}}
3. REQUIREMENTS      -- numbered list of specific, verifiable acceptance criteria
4. CONSTRAINTS       -- IMPORTANT: block with file-write scope and limits
```

### Template with variable slots

```ts
task: `Apply the {{SKILL_REFERENCE}} (already installed at {{SKILL_PATH}}) to {{TASK_VERB}} for {{PACKAGE_NAME}}.

Current {{CONTEXT_FILE_LABEL}}:
{{steps.read-<context-step>.output}}

{{TASK_IMPERATIVE}} with these requirements:

{{NUMBERED_REQUIREMENTS}}

IMPORTANT: Write the updated file to disk at {{OUTPUT_PATH}}. Only modify {{ALLOWED_FILES}}. Do NOT touch any other file.`
```

**Variable slots**:

| Slot | Source | Example |
|---|---|---|
| `SKILL_REFERENCE` | `persona.skills[0].id` | `@prpm/npm-trusted-publishing` |
| `SKILL_PATH` | `materializeSkills().installs[0].installedDir` + `/SKILL.md` | `.opencode/skills/npm-trusted-publishing/` |
| `TASK_VERB` | User-provided task description | `configure OIDC trusted publishing` |
| `PACKAGE_NAME` | Target package from task context | `@agentworkforce/workload-router` |
| `CONTEXT_FILE_LABEL` | Human-readable label for the injected file | `.github/workflows/publish.yml` |
| `TASK_IMPERATIVE` | Derived action verb | `Rewrite .github/workflows/publish.yml in-place` |
| `NUMBERED_REQUIREMENTS` | Task-specific acceptance criteria (numbered list) | `1. REMOVE all NODE_AUTH_TOKEN...` |
| `OUTPUT_PATH` | Where the agent should write output | `.github/workflows/publish.yml` |
| `ALLOWED_FILES` | Explicit scope limit | `this file and optionally packages/workload-router/package.json` |

### Prompt patterns by persona type

**Skill-bearing personas** (currently only `npm-provenance-publisher`):
- Always reference the installed skill by path
- Include "already installed at X" to prevent the agent from re-installing
- Inject file contents from context-read steps
- End with explicit file-write scope constraints

```ts
task: `Apply the {{SKILL_ID}} skill (already installed at {{SKILL_DIR}}/) to {{ACTION}}.

Current {{FILE_LABEL}}:
{{steps.read-<step>.output}}

{{IMPERATIVE}} with these requirements:
1. {{REQUIREMENT_1}}
2. {{REQUIREMENT_2}}
...

IMPORTANT: Write the updated file to disk at {{OUTPUT_PATH}}. Only modify {{SCOPE}}. Do NOT touch any other file.`
```

**Analysis personas** (e.g. `security-review`, `review`, `test-strategy`, `architecture-plan`):
- No skill reference (these personas have no skills)
- Inject source code, diffs, or file listings
- End with "Write your analysis to X" rather than "modify X"

```ts
task: `{{ANALYSIS_DIRECTIVE}}.

{{CONTEXT_LABEL_1}}:
{{steps.read-<step1>.output}}

{{CONTEXT_LABEL_2}}:
{{steps.read-<step2>.output}}

Produce a structured analysis covering:
1. {{SECTION_1}}
2. {{SECTION_2}}
...

Write your analysis to {{OUTPUT_PATH}}. Be concrete -- reference specific {{DOMAIN_OBJECTS}}.`
```

**Multi-phase investigation** (investigation workflow demonstrates this):
- Phase outputs become inputs to subsequent phases via intermediate read steps
- Each phase has its own agent and prompt
- Later prompts reference "Using the investigation findings, ..."

```ts
// Phase N+1 reads Phase N output
.step('read-phase-n-output', {
  type: 'deterministic',
  dependsOn: ['phase-n-agent-step'],
  command: 'cat <phase-n-output-file>',
  captureOutput: true,
  failOnError: true
})

.step('phase-n-plus-1', {
  agent: '<next-agent>',
  dependsOn: ['read-phase-n-output', ...],
  task: `Using the {{PREVIOUS_PHASE_LABEL}}:
{{steps.read-phase-n-output.output}}

{{NEXT_PHASE_DIRECTIVE}}...`
})
```

**Checker agent** (universal, invariant prompt):

```ts
task: 'Run `corepack pnpm run check` from the repo root. Report the full stderr/stdout of any failing command verbatim. Do not attempt fixes; just report. If everything passes, print the final "check" summary.'
```

### Step output interpolation

The only interpolation syntax is `{{steps.<stepId>.output}}`. Steps whose output will be
injected must have `captureOutput: true`. The workflow engine replaces these tokens at
runtime before dispatching to the agent.

---

## 5. ERROR HANDLING

### Global error strategy

All three workflows use the same strategy:

```ts
.onError('fail-fast')
```

On the first step failure, cancel all in-flight steps and abort. No workflows use
`continue` or `retry-step` at the global level.

### Per-step failure configuration

| Step category | `failOnError` | `retries` | Rationale |
|---|---|---|---|
| Bootstrap (install, build) | `true` | 0 | No point continuing if deps fail |
| Skill materialization (plan, install, verify) | `true` | 0 | Agent can't work without its skills |
| Context reads | `true` | 0 | Missing context = broken prompt |
| Agent execution (primary) | N/A (agent step) | 2 | LLM agents are non-deterministic; retries help |
| Agent execution (analyst) | N/A (agent step) | 1 | Analysis is more deterministic than code generation |
| Verification gates | `true` | 0 | Deterministic -- if it fails, the output is wrong |
| Checker agent | N/A (agent step) | 0-1 | Final gate; usually 1 retry or none |
| Git diff/status (informational) | `false` | 0 | Purely informational; never blocks |

### Error strategy mapped to persona types

| Persona type | Agent retries | Verification heaviness | Reasoning |
|---|---|---|---|
| **File-modifying** (`npm-provenance`, `implement-frontend`) | 2 | Heavy (negative + positive greps, JSON checks) | Wrong file changes are dangerous; verify thoroughly but retry the agent |
| **Analysis/review** (`security-review`, `review`, `test-strategy`) | 1 | Light (file existence only) | Analysis is idempotent and lower-risk |
| **Investigation/research** (multi-phase) | 2 per phase agent | Medium (batch file existence) | Multi-step research has more failure modes |
| **Debugging** (`debugging`, `flake-investigation`) | 2 | Medium (test rerun + exit code) | Exploratory; retries allow different root-cause paths |
| **Verification/audit** (`verification`) | 1 | None (verifier IS the check) | Self-contained; low retry need |

### Retry allocation by preset

| Preset | Typical retries | Reasoning |
|---|---|---|
| `worker` (code/config tasks) | 2 | Non-deterministic code generation benefits from retries |
| `analyst` (read-only analysis) | 1 | Analysis is more stable; less retry benefit |
| `checker` (universal) | 1 | Running `pnpm run check` is nearly deterministic |

---

## 6. WORKFLOW METADATA

### Top-level configuration (mostly invariant)

```ts
workflow('<NAME>')
  .description('<1-2 sentence description>')
  .pattern('dag')                              // Always 'dag' in all existing workflows
  .channel('wf-<NAME>')                        // Convention: 'wf-' + kebab-case workflow name
  .maxConcurrency(4)                           // Always 4 in existing workflows
  .timeout(3_600_000)                          // Always 1 hour (3,600,000ms)
```

**Variable parts**: `name`, `description`, `channel` (derived from name).
**Invariant parts**: `pattern` (always `dag`), `maxConcurrency` (always 4), `timeout` (always 1h).

A generator could potentially vary `maxConcurrency` and `timeout` based on the persona's
`harnessSettings.timeoutSeconds` field (ranging from 300s to 1500s across personas), but
existing workflows don't do this.

### CJS boilerplate wrapper (100% invariant)

```ts
const { workflow } = require('@agent-relay/sdk/workflows');

async function main() {
  const result = await workflow('<NAME>')
    // ... fluent chain ...
    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

The generator can emit this wrapper verbatim, substituting only the workflow name.

---

## 7. COMPLETE TEMPLATE STRUCTURE

### Generator input interface

A workflow generator needs these inputs to produce a complete workflow:

```ts
interface WorkflowGeneratorInput {
  // --- Metadata (partially derivable) ---
  name: string;                       // e.g. 'configure-trusted-publishing'
  description: string;                // e.g. 'Rewrite publish.yml for OIDC...'

  // --- Persona resolution (required) ---
  personaIntent: PersonaIntent;       // e.g. 'npm-provenance'
  routingProfile?: string;            // defaults to 'default'

  // --- Context gathering (task-specific) ---
  contextFiles: Array<{
    stepName: string;                 // e.g. 'read-publish-yml'
    command: string;                  // e.g. 'cat .github/workflows/publish.yml'
  }>;

  // --- Agent task (task-specific) ---
  taskPrompt: string;                 // Multi-line, may contain {{steps.X.output}} refs
  taskVerification:
    | { type: 'exit_code' }
    | { type: 'file_exists'; value: string };
  taskRetries?: number;               // defaults to 2 for workers, 1 for analysts

  // --- Verification gates (task-specific) ---
  verifications: Array<{
    stepName: string;                 // e.g. 'verify-no-npm-token'
    command: string;                  // The shell assertion command
  }>;

  // --- Final capture (optional) ---
  finalCapture?: 'git-diff' | 'git-status';
  finalCaptureTarget?: string;        // e.g. '.github/workflows/publish.yml'

  // --- Advanced (optional) ---
  frozenLockfile?: boolean;           // defaults to true
  additionalAgents?: Array<{          // for multi-agent workflows
    id: string;
    cli: Harness;
    preset: 'worker' | 'analyst';
    role: string;
    retries: number;
  }>;
}
```

### Generation algorithm

Given a `WorkflowGeneratorInput`, the generator:

1. **Resolve persona**: `resolvePersona(input.personaIntent, input.routingProfile)`
2. **Extract harness**: `selection.runtime.harness`
3. **Determine preset**: `worker` if intent is in the modification set, `analyst` otherwise
4. **Emit boilerplate open**: `const { workflow } = require(...)` + `workflow(name).description(...)`
5. **Emit agent definitions**:
   - Primary agent: `{ cli: harness, preset, role: shortenDescription(persona.description), retries }`
   - Checker agent: `{ cli: 'codex', preset: 'worker', role: '...', retries: 1 }` (invariant)
   - Any additional agents from `input.additionalAgents`
6. **Emit Phase A** (bootstrap): invariant `install-deps` + `build-sdk` steps
7. **Emit Phase B** (skill materialization): only if `selection.skills.length > 0`
   - `plan-skills`: node one-liner calling `resolvePersona('<intent>')` + `materializeSkillsFor()`
   - `install-skills`: node one-liner with `spawnSync`
   - `verify-skill-installed`: `test -d <HARNESS_SKILL_TARGETS[harness].dir>/<skillName>` or `test -f <path>/SKILL.md`
8. **Emit Phase C** (context gathering): one step per `input.contextFiles` entry
9. **Emit Phase D** (agent execution): agent step with `dependsOn` = skill-verify (if present) + all context step ids
10. **Emit Phase E** (verification gates): one step per `input.verifications` entry, all depending on agent step
11. **Emit Phase F** (final guardrail): checker step depending on all verification gates + optional git capture
12. **Emit boilerplate close**: `.onError('fail-fast').run(...)` + `main().catch(...)`

### What's truly task-specific vs. derivable

| Input | Task-specific? | Derivable from? |
|---|---|---|
| `name` | Yes | User provides |
| `description` | Yes | User provides |
| `personaIntent` | Yes | User selects persona |
| `routingProfile` | No | Defaults to `'default'` |
| Agent `cli` | No | `selection.runtime.harness` |
| Agent `preset` | No | Intent -> preset heuristic |
| Agent `role` | No | `persona.description` (shortened) |
| Skill install steps | No | `selection.skills.length > 0` -> template |
| `contextFiles` | **Yes** | User must specify what the agent needs to read |
| `taskPrompt` | **Yes** | User must describe the task; skill refs can be templated |
| `verifications` | **Yes** | User must define acceptance criteria as shell assertions |
| `finalCapture` | Partially | `git-diff` for file-mod tasks, `git-status` for file-create |
| Checker agent | No | Always emitted; invariant definition and prompt |
| Error handling | No | Always `fail-fast`; retries from preset heuristic |
| Metadata (`pattern`, `maxConcurrency`, `timeout`) | No | Always `dag` / `4` / `3_600_000` |

**Summary**: Only four inputs are truly task-specific: `contextFiles`, `taskPrompt`,
`verifications`, and (partially) `finalCapture`. Everything else is derivable from the
persona resolution and conventions established across all three existing workflows.

---

## 8. CROSS-WORKFLOW DIFF ANALYSIS

### Structural differences between the three workflows

| Aspect | configure-trusted-publishing | finish-npm-provenance-persona | investigate-agent-profiles |
|---|---|---|---|
| **Agents** | 2 (publisher + checker) | 2 (publisher + checker) | 3 (analyst + planner + generator) |
| **Primary CLI** | opencode | claude | claude + codex |
| **Has skills?** | Yes (npm-trusted-publishing) | Yes (npm-trusted-publishing) | No |
| **Context reads** | 2 (publish.yml + pkg.json) | 1 (pkg.json) | 5 (catalog, profile, personas, workflows, publish.yml) |
| **Agent steps** | 1 (rewrite-publish-workflow) | 1 (create-publish-workflow) | 6 (analyze x2, plan, generate x3) |
| **Verification gates** | 5 (negative grep, positive greps, json check) | 2 (file exists + positive grep, json check) | 1 (batch file existence) |
| **Final capture** | git diff (specific file) | git status (broad) | None |
| **Phases** | Linear DAG | Linear DAG | Multi-phase DAG (3 sequential phases, fan-out in phase 3) |

### The investigation workflow as a template for multi-phase patterns

The investigation workflow demonstrates how to chain phases:

```
Phase 1: Read inputs (parallel) --> Analyze (2 parallel agents)
Phase 2: Read phase-1 outputs --> Write design plan (1 agent)
Phase 3: Read plan --> Generate templates (3 parallel agents) --> Verify all outputs
```

This "read -> process -> read output -> process further" pattern is the basis for any
multi-step workflow. The generator should support declaring phase boundaries where
intermediate read steps bridge agent outputs into subsequent agent inputs.

### Frozen-lockfile inconsistency

`configure-trusted-publishing.ts` uses `corepack pnpm install` (no `--frozen-lockfile`),
while `finish-npm-provenance-persona.ts` uses `--frozen-lockfile`. This is the only
inconsistency in the bootstrap phase across workflows. The generator should standardize
on `--frozen-lockfile` as the default.
