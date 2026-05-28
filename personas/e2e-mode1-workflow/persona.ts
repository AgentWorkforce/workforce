import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Minimal Mode 1 persona (workflow-DSL execution path).
 *
 * Trigger: a GitHub issue is opened or labeled on AgentWorkforce/cloud.
 * Action:  if the issue carries the `workflow-test` label, the handler
 *          materializes a workflows/<name>.ts file and invokes it via
 *          `ctx.workflow.run(...)`. The workflow is a 3-step deterministic
 *          DAG that exercises inter-step data flow (step N reads what
 *          step N-1 wrote to a known on-disk path). After the workflow
 *          completes, the handler posts two GitHub comments via
 *          `ctx.github.comment` — one ack, one carrying the first line of
 *          the issue body computed by the workflow.
 *
 * Why split workflow vs. handler this way:
 * - The `@agent-relay/sdk/workflows` DSL (Mode 1) supports `deterministic`
 *   shell steps and `agent`-driven steps inside a DAG. It does NOT ship
 *   first-class primitives like "post GitHub comment". The canonical
 *   pattern (see cloud-small-issue-codex) is: workflow does the compute,
 *   handler does the integration writeback via the runtime's `ctx.<provider>`
 *   clients. This persona follows that pattern verbatim, so it proves the
 *   Mode 1 execution path (handler -> ctx.workflow.run -> cloud workflows
 *   API -> daytona DAG run -> completion poll) end-to-end with the smallest
 *   possible workflow.
 *
 * Exists to prove the Mode 1 path with no clone, no agent step, no PR
 * machinery — just a deterministic 3-step DAG and two integration writes.
 */
export default definePersona({
  id: 'e2e-mode1-workflow',
  intent: 'review',
  tags: ['review'],
  description:
    'Minimal Mode 1 E2E probe: replies to AgentWorkforce/cloud issues labeled `workflow-test` by running a 3-step deterministic workflow DSL DAG and posting its output back as two GitHub comments, to prove the workflow-DSL execution path runs end-to-end.',
  cloud: true,
  onEvent: './agent.ts',
  // Stub harness fields — required by the cloud deploy validator even
  // though this is a pure-handler persona that never calls
  // ctx.harness.run (the persona-kit parser is fine with omitting them
  // for handler-style personas, but the cloud-side validator still
  // requires harness/model/systemPrompt to be present). Mirrors the
  // committed shape of e2e-mode2-hello.
  harness: 'codex',
  model: 'gpt-5',
  systemPrompt: 'Handle the proactive event.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 300 },
  integrations: {
    github: {
      source: { kind: 'workspace' },
      triggers: [
        // Only `issues.opened` — `issues.labeled` is not in the known-trigger
        // registry for github (deploy warns), and we already capture the
        // primary fire path via `opened`. Operators who want to re-fire a
        // closed test cycle should close+reopen the issue rather than
        // re-add the label.
        { on: 'issues.opened' }
      ]
    }
  }
});
