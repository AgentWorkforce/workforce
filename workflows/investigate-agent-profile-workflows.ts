/**
 * Investigate and plan the `--agent` flag for agent-relay.
 *
 * Goal: design how `agent-relay run "task description" --agent <persona-id>`
 * auto-generates and executes a workflow from a persona profile. Instead of
 * hand-writing workflow files, the CLI would:
 *   1. Resolve the persona via the workload-router SDK
 *   2. Pick the best swarm pattern based on the task + persona capabilities
 *   3. Generate the workflow DAG (skill install, task execution, verification)
 *   4. Execute it
 *
 * This investigation workflow uses claude (analyst) and codex (implementer) to:
 *   - Analyze the existing persona system, routing profiles, and workflow patterns
 *   - Produce a design plan for the --agent flag
 *   - Generate several concrete workflow templates as reference implementations
 *
 * Run with:
 *   agent-relay run --dry-run workflows/investigate-agent-profile-workflows.ts
 *   agent-relay run          workflows/investigate-agent-profile-workflows.ts
 */

const { workflow } = require('@agent-relay/sdk/workflows');

async function main() {
  const result = await workflow('investigate-agent-profile-workflows')
    .description(
      'Investigate and plan auto-generating agent-relay workflows from persona profiles via --agent flag.'
    )
    .pattern('dag')
    .channel('wf-investigate-agent-profiles')
    .maxConcurrency(4)
    .timeout(3_600_000)

    .agent('analyst', {
      cli: 'claude',
      preset: 'analyst',
      role: 'Codebase analyst and architect for the --agent flag feature',
      retries: 1
    })
    .agent('planner', {
      cli: 'claude',
      preset: 'worker',
      role: 'Writes the design plan document',
      retries: 2
    })
    .agent('generator', {
      cli: 'codex',
      preset: 'worker',
      role: 'Generates workflow template files from the plan',
      retries: 2
    })

    // --- Read all inputs in parallel -----------------------------------------

    .step('read-persona-catalog', {
      type: 'deterministic',
      command: 'cat packages/workload-router/src/index.ts',
      captureOutput: true,
      failOnError: true
    })

    .step('read-routing-profile', {
      type: 'deterministic',
      command: 'cat packages/workload-router/routing-profiles/default.json',
      captureOutput: true,
      failOnError: true
    })

    .step('read-all-personas', {
      type: 'deterministic',
      command: 'for f in personas/*.json; do echo "=== $f ==="; cat "$f"; echo; done',
      captureOutput: true,
      failOnError: true
    })

    .step('read-existing-workflows', {
      type: 'deterministic',
      command: 'for f in workflows/*.ts; do echo "=== $f ==="; cat "$f"; echo; done',
      captureOutput: true,
      failOnError: true
    })

    .step('read-publish-workflow', {
      type: 'deterministic',
      command: 'cat .github/workflows/publish.yml',
      captureOutput: true,
      failOnError: true
    })

    // --- Phase 1: Analyze the system -----------------------------------------

    .step('analyze-persona-system', {
      agent: 'analyst',
      dependsOn: ['read-persona-catalog', 'read-routing-profile', 'read-all-personas'],
      task: `Analyze the persona and routing system in this repo to understand how workflows could be auto-generated from persona profiles.

Persona catalog and SDK (packages/workload-router/src/index.ts):
{{steps.read-persona-catalog.output}}

Routing profile (routing-profiles/default.json):
{{steps.read-routing-profile.output}}

All persona definitions:
{{steps.read-all-personas.output}}

Produce a structured analysis covering:
1. PERSONA CAPABILITIES: What information does each persona carry that is relevant to workflow generation? (harness, model, skills, systemPrompt, tier routing)
2. PATTERN SELECTION HEURISTICS: For each persona intent, what swarm pattern fits best? Map each intent to a recommended pattern with reasoning.
3. SKILL MATERIALIZATION: How does the skill install flow work? What are the steps every auto-generated workflow needs?
4. COMMON WORKFLOW STRUCTURE: What steps are common across all persona-driven workflows? (install deps, build SDK, resolve persona, install skills, verify, execute task, verify output, final check)
5. VARIABLE PARTS: What differs per persona? (verification gates, file targets, task prompts, agent CLI choice)

Write your analysis to workflows/investigation/persona-analysis.md. Be concrete — reference specific personas, intents, and code paths.`,
      verification: { type: 'file_exists', value: 'workflows/investigation/persona-analysis.md' }
    })

    .step('analyze-workflow-patterns', {
      agent: 'analyst',
      dependsOn: ['read-existing-workflows', 'read-publish-workflow'],
      task: `Analyze the existing hand-written workflows to extract the common patterns and variable parts that a workflow generator would need to template.

Existing workflows:
{{steps.read-existing-workflows.output}}

GitHub Actions publish workflow:
{{steps.read-publish-workflow.output}}

Produce a structured analysis covering:
1. COMMON SKELETON: The DAG steps that appear in every workflow (install, build, skill install, verify, execute, check)
2. AGENT CONFIGURATION: How agent CLI, preset, and role map from persona tiers
3. VERIFICATION PATTERNS: What verification gates are used and when — map persona types to appropriate verification strategies
4. TASK PROMPT TEMPLATES: How task prompts are structured — what gets injected, what's static
5. ERROR HANDLING: What error strategies fit which persona types

Write your analysis to workflows/investigation/workflow-patterns.md. Include concrete code snippets showing the template structure.`,
      verification: { type: 'file_exists', value: 'workflows/investigation/workflow-patterns.md' }
    })

    // --- Phase 2: Create the design plan -------------------------------------

    .step('read-persona-analysis', {
      type: 'deterministic',
      dependsOn: ['analyze-persona-system'],
      command: 'cat workflows/investigation/persona-analysis.md',
      captureOutput: true,
      failOnError: true
    })

    .step('read-workflow-patterns', {
      type: 'deterministic',
      dependsOn: ['analyze-workflow-patterns'],
      command: 'cat workflows/investigation/workflow-patterns.md',
      captureOutput: true,
      failOnError: true
    })

    .step('write-design-plan', {
      agent: 'planner',
      dependsOn: ['read-persona-analysis', 'read-workflow-patterns'],
      task: `Using the investigation findings, write a design plan for the agent-relay --agent flag feature.

Persona system analysis:
{{steps.read-persona-analysis.output}}

Workflow pattern analysis:
{{steps.read-workflow-patterns.output}}

The feature goal:
  agent-relay run "configure trusted publishing" --agent npm-provenance-publisher

This command should:
1. Parse the task description ("configure trusted publishing")
2. Resolve the persona by id or intent (npm-provenance-publisher -> npm-provenance intent)
3. Select the swarm pattern (dag, pipeline, fan-out, etc.) based on persona + task
4. Auto-generate a complete workflow with: skill install, context gathering, task execution, verification gates
5. Execute it

Write the design plan to workflows/investigation/design-plan.md with these sections:

## CLI Interface
- Flag syntax, argument parsing, how --agent resolves to a persona
- How the task description influences workflow generation

## Workflow Generator
- The template engine: how the common skeleton + persona-specific parts combine
- Pattern selection logic: decision tree for choosing dag vs pipeline vs fan-out
- Step generation rules: which steps to include based on persona capabilities

## Pattern Selection Matrix
- A concrete table mapping each persona intent to its recommended pattern with reasoning

## Generated Workflow Structure
- The canonical step ordering for generated workflows
- How verification gates are selected per persona type

## Implementation Plan
- Ordered list of implementation tasks
- Which files to create/modify in the agent-relay SDK
- Testing strategy

IMPORTANT: Write the file to disk at workflows/investigation/design-plan.md. Do NOT output to stdout.`,
      verification: { type: 'file_exists', value: 'workflows/investigation/design-plan.md' }
    })

    // --- Phase 3: Generate reference workflow templates -----------------------

    .step('read-design-plan', {
      type: 'deterministic',
      dependsOn: ['write-design-plan'],
      command: 'cat workflows/investigation/design-plan.md',
      captureOutput: true,
      failOnError: true
    })

    .step('generate-security-review-workflow', {
      agent: 'generator',
      dependsOn: ['read-design-plan', 'read-persona-catalog'],
      task: `Generate a reference workflow template that would be auto-generated by:
  agent-relay run "review this PR for security issues" --agent security-reviewer

Use the design plan and persona catalog to produce the workflow.

Design plan:
{{steps.read-design-plan.output}}

Persona catalog:
{{steps.read-persona-catalog.output}}

The workflow should:
- Resolve the security-reviewer persona via the SDK
- Install any skills the persona declares
- Read relevant files (git diff, changed files list)
- Execute the security review task with the correct CLI/harness from the persona tier
- Verify output (review findings written to file)

Write to: workflows/investigation/generated/security-review.ts
Use the same CJS style as existing workflows (require, async function main).
IMPORTANT: Write the file to disk. Do NOT output to stdout.`,
      verification: { type: 'file_exists', value: 'workflows/investigation/generated/security-review.ts' }
    })

    .step('generate-test-strategy-workflow', {
      agent: 'generator',
      dependsOn: ['read-design-plan', 'read-persona-catalog'],
      task: `Generate a reference workflow template that would be auto-generated by:
  agent-relay run "create a test strategy for the workload-router package" --agent test-strategist

Use the design plan and persona catalog to produce the workflow.

Design plan:
{{steps.read-design-plan.output}}

Persona catalog:
{{steps.read-persona-catalog.output}}

The workflow should:
- Resolve the test-strategist persona via the SDK
- Install any skills the persona declares
- Read the target package source files
- Execute the test strategy task with the correct CLI/harness from the persona tier
- Verify output (strategy document written to file)

Write to: workflows/investigation/generated/test-strategy.ts
Use the same CJS style as existing workflows (require, async function main).
IMPORTANT: Write the file to disk. Do NOT output to stdout.`,
      verification: { type: 'file_exists', value: 'workflows/investigation/generated/test-strategy.ts' }
    })

    .step('generate-code-review-workflow', {
      agent: 'generator',
      dependsOn: ['read-design-plan', 'read-persona-catalog'],
      task: `Generate a reference workflow template that would be auto-generated by:
  agent-relay run "review the latest changes for quality" --agent code-reviewer

Use the design plan and persona catalog to produce the workflow.

Design plan:
{{steps.read-design-plan.output}}

Persona catalog:
{{steps.read-persona-catalog.output}}

The workflow should:
- Resolve the code-reviewer persona via the SDK
- Install any skills the persona declares
- Read git diff of recent changes
- Execute the code review task with the correct CLI/harness from the persona tier
- Verify output (review written to file)

Write to: workflows/investigation/generated/code-review.ts
Use the same CJS style as existing workflows (require, async function main).
IMPORTANT: Write the file to disk. Do NOT output to stdout.`,
      verification: { type: 'file_exists', value: 'workflows/investigation/generated/code-review.ts' }
    })

    // --- Verify all outputs exist --------------------------------------------

    .step('verify-outputs', {
      type: 'deterministic',
      dependsOn: [
        'generate-security-review-workflow',
        'generate-test-strategy-workflow',
        'generate-code-review-workflow'
      ],
      command: [
        'missing=0',
        'for f in workflows/investigation/persona-analysis.md workflows/investigation/workflow-patterns.md workflows/investigation/design-plan.md workflows/investigation/generated/security-review.ts workflows/investigation/generated/test-strategy.ts workflows/investigation/generated/code-review.ts; do',
        '  if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi',
        'done',
        'if [ $missing -gt 0 ]; then echo "$missing files missing"; exit 1; fi',
        'echo "All 6 outputs present"',
        'echo "---"',
        'find workflows/investigation -type f | sort'
      ].join('; '),
      failOnError: true
    })

    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
