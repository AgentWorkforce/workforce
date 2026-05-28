import { handler } from '@agentworkforce/runtime';

/**
 * Minimal Mode 1 handler.
 *
 * Flow:
 *   1. Listen for GitHub `issues.opened` / `issues.labeled` events on
 *      AgentWorkforce/cloud.
 *   2. Gate on issue state=open AND label includes `workflow-test`.
 *   3. Materialize `workflows/e2e-mode1-workflow.ts` (the @agent-relay/sdk
 *      DSL source) via ctx.files.write. The source is parameterized by
 *      the issue number + body so the workflow has the data it needs.
 *   4. Invoke `ctx.workflow.run(WORKFLOW_NAME, { ... })`, which POSTs the
 *      workflow source to the cloud workflows API, which runs the DAG in
 *      a daytona sandbox.
 *   5. Await `run.completion()`. The workflow's final step writes the
 *      issue body's first line to `/tmp/<name>/summary.txt` and echoes it
 *      back as stdout, which surfaces in the completion output.
 *   6. Post two comments via `ctx.github.comment`:
 *        - one ack ("Mode 1 workflow ran for issue #N")
 *        - one carrying the workflow-derived first line
 *      We do this from the handler (not the workflow) because the DSL has
 *      no first-class "post comment" primitive — the canonical pattern is
 *      compute in the workflow, write back via ctx.<provider> in the handler.
 *
 * Anything else (wrong source, wrong type, wrong repo, wrong label, closed
 * issue) is ignored. No clone, no agent step, no PR machinery.
 */

const REPO_OWNER = 'AgentWorkforce';
const REPO_NAME = 'cloud';
const REPO_FULL_NAME = `${REPO_OWNER}/${REPO_NAME}`;
const LABEL = 'workflow-test';
const WORKFLOW_NAME = 'e2e-mode1-workflow';

export default handler(async (ctx, event) => {
  if (event.source !== 'github') {
    ctx.log('info', 'ignoring unsupported event source', { source: event.source });
    return;
  }
  if (event.type !== 'issues.opened') {
    ctx.log('info', 'ignoring non-issue-opened event', { type: event.type });
    return;
  }

  const resource = asRecord(event.payload);
  const issue = maybeRecord(resource.issue) ?? resource;
  const repo = asRecord(resource.repository);
  const fullName = stringValue(repo?.full_name) ?? REPO_FULL_NAME;
  if (fullName !== REPO_FULL_NAME) {
    ctx.log('info', 'ignoring event for different repo', { fullName });
    return;
  }

  const issueState = stringValue(issue.state ?? resource.state)?.toLowerCase();
  if (issueState !== 'open') {
    ctx.log('info', 'skipping non-open issue', { issueState, eventId: event.id });
    return;
  }

  const labels = readLabels(issue.labels ?? resource.labels);
  if (!labels.includes(LABEL)) {
    ctx.log('info', 'skipping issue without workflow-test label', {
      labels,
      eventId: event.id
    });
    return;
  }

  const issueNumber = numberValue(issue.number ?? resource.number);
  if (!issueNumber) {
    ctx.log('warn', 'missing issue number', { eventId: event.id });
    return;
  }
  const issueTitle = stringValue(issue.title ?? resource.title) ?? '(no title)';
  const issueBody = stringValue(issue.body ?? resource.body) ?? '';

  if (!ctx.workflow?.run) {
    // Fail loud: missing workflow context means the runner isn't connected
    // to the cloud workflows API. Surface in cloud-web tail rather than
    // appearing green-but-no-op.
    ctx.log('warn', 'ctx.workflow.run unavailable; Mode 1 path cannot execute', {
      issueNumber
    });
    return;
  }

  // Materialize the workflow source. The cloud workflows API will read
  // this file off disk (workspaceRoot/workflows/<name>.ts) when we call
  // ctx.workflow.run — see runtime/src/cloud-defaults.ts:readBundledWorkflowSource.
  await ctx.files.write(
    `workflows/${WORKFLOW_NAME}.ts`,
    workflowSource({ issueNumber, issueBody })
  );

  ctx.log('info', 'dispatching Mode 1 workflow', { issueNumber, workflow: WORKFLOW_NAME });
  const run = await ctx.workflow.run(WORKFLOW_NAME, { issueNumber, issueBody });
  const completion = await run.completion();
  ctx.log('info', 'workflow completed', {
    issueNumber,
    runId: run.runId,
    status: completion.status
  });

  // Pull the first-line summary the workflow's final step echoed to stdout.
  // The completion.output shape is whatever the cloud workflows API returned;
  // we accept either string or object and extract the marker.
  const firstLine = extractFirstLineMarker(completion.output) ?? firstLineOf(issueBody);

  if (!ctx.github?.comment) {
    ctx.log('warn', 'ctx.github.comment unavailable; comments dropped', {
      issueNumber,
      workflowStatus: completion.status
    });
    return;
  }

  // Step-2 equivalent — ack the receipt. Done after workflow so we can
  // include the runId for debug correlation in cloud-web/relayfile tails.
  await ctx.github.comment(
    { owner: REPO_OWNER, repo: REPO_NAME, number: issueNumber },
    `Mode 1 workflow ran for #${issueNumber}. ` +
      `Workflow run id: \`${run.runId}\`, status: \`${completion.status}\`. ` +
      `Title: ${issueTitle}.`
  );

  // Step-3 equivalent — surface the workflow-derived first line, proving
  // data flowed step1 -> step2 -> step3 inside the DAG, then back out
  // through completion.output, then back into a GitHub write.
  await ctx.github.comment(
    { owner: REPO_OWNER, repo: REPO_NAME, number: issueNumber },
    `Issue body first line (computed by workflow step \`summarize\`): ` +
      (firstLine ? `\`${firstLine}\`` : '`(issue body was empty)`')
  );

  ctx.log('info', 'posted Mode 1 workflow comments', {
    issueNumber,
    runId: run.runId,
    firstLinePreview: firstLine?.slice(0, 80) ?? null
  });
});

/**
 * Emit the workflow DSL source. Stringly-typed by necessity — the cloud
 * workflows API receives this as a text blob and runs it inside daytona,
 * NOT in this handler's process, so we can't share JS types across the
 * boundary. We use `String.raw` for the script body to keep escape rules
 * legible and inject the issue values as JSON literals at the top.
 *
 * The DAG:
 *   step `extract-body`     [deterministic shell]
 *     writes the issue body to /tmp/e2e-mode1/body.txt
 *
 *   step `acknowledge`      [deterministic shell, depends on extract-body]
 *     reads /tmp/e2e-mode1/body.txt, writes a short ack to
 *     /tmp/e2e-mode1/ack.txt. Demonstrates that step 2 sees the file
 *     step 1 wrote — the simplest possible inter-step data flow.
 *
 *   step `summarize`        [deterministic shell, depends on acknowledge]
 *     reads /tmp/e2e-mode1/body.txt, extracts the first line, writes
 *     /tmp/e2e-mode1/summary.txt, AND echoes it to stdout prefixed with
 *     a stable marker so the handler can recover it from completion.output.
 */
export function workflowSource(args: { issueNumber: number; issueBody: string }): string {
  const issueBodyJson = JSON.stringify(args.issueBody);
  const issueNumberJson = JSON.stringify(String(args.issueNumber));
  return `
import { workflow } from '@agent-relay/sdk/workflows';

const ISSUE_NUMBER = ${issueNumberJson};
const ISSUE_BODY = ${issueBodyJson};
const WORK_DIR = '/tmp/e2e-mode1-' + ISSUE_NUMBER;
const FIRST_LINE_MARKER = 'E2E_MODE1_FIRST_LINE=';

function shellSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\\\''") + "'";
}

await workflow('e2e-mode1-workflow-' + ISSUE_NUMBER)
  .description('Minimal Mode 1 E2E workflow DAG for issue #' + ISSUE_NUMBER)
  .pattern('dag')
  .timeout(120000)
  .step('extract-body', {
    type: 'deterministic',
    command: [
      'set -e',
      'mkdir -p ' + shellSingleQuote(WORK_DIR),
      'printf %s ' + shellSingleQuote(ISSUE_BODY) + ' > ' + shellSingleQuote(WORK_DIR + '/body.txt'),
      'echo "extract-body: wrote $(wc -c < ' + shellSingleQuote(WORK_DIR + '/body.txt') + ') bytes"'
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
    timeoutMs: 30000
  })
  .step('acknowledge', {
    type: 'deterministic',
    dependsOn: ['extract-body'],
    command: [
      'set -e',
      'test -f ' + shellSingleQuote(WORK_DIR + '/body.txt'),
      'bytes=$(wc -c < ' + shellSingleQuote(WORK_DIR + '/body.txt') + ')',
      'printf "acknowledge: issue #%s, %s body bytes\\n" ' + shellSingleQuote(ISSUE_NUMBER) + ' "$bytes" > ' + shellSingleQuote(WORK_DIR + '/ack.txt'),
      'cat ' + shellSingleQuote(WORK_DIR + '/ack.txt')
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
    timeoutMs: 30000
  })
  .step('summarize', {
    type: 'deterministic',
    dependsOn: ['acknowledge'],
    command: [
      'set -e',
      'test -f ' + shellSingleQuote(WORK_DIR + '/body.txt'),
      'test -f ' + shellSingleQuote(WORK_DIR + '/ack.txt'),
      'first_line=$(head -n 1 ' + shellSingleQuote(WORK_DIR + '/body.txt') + ' || true)',
      'printf %s "$first_line" > ' + shellSingleQuote(WORK_DIR + '/summary.txt'),
      'echo "summarize: first line written to summary.txt"',
      'echo "' + FIRST_LINE_MARKER + '$first_line"'
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
    timeoutMs: 30000
  })
  .run();
`;
}

// ─── completion-output helpers ─────────────────────────────────────────────

function extractFirstLineMarker(output: unknown): string | null {
  const text = typeof output === 'string' ? output : safeStringify(output);
  if (!text) return null;
  const match = text.match(/E2E_MODE1_FIRST_LINE=([^\n\r]*)/);
  if (!match) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? '');
  }
}

function firstLineOf(body: string): string | null {
  if (!body) return null;
  const line = body.split(/\r?\n/).find((entry) => entry.trim().length > 0);
  return line ? line.trim() : null;
}

// ─── event-shape helpers (verbatim from e2e-mode2-hello) ───────────────────

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function maybeRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function readLabels(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(asRecord(entry).name ?? entry).toLowerCase())
    : [];
}
