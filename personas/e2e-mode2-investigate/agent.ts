import { handler } from '@agentworkforce/runtime';

/**
 * Mode 2 investigation handler.
 *
 * Listens for GitHub `issues.labeled` events on AgentWorkforce/cloud. If the
 * issue is open and carries the `investigate` label, asks the codex harness
 * to read repo code under ctx.sandbox.cwd and produce a 3-5 paragraph
 * diagnosis, then posts it as a single comment via ctx.github.comment.
 */

const REPO_OWNER = 'AgentWorkforce';
const REPO_NAME = 'cloud';
const REPO_FULL_NAME = `${REPO_OWNER}/${REPO_NAME}`;
const LABEL = 'investigate';

export default handler(async (ctx, event) => {
  if (event.source !== 'github' || event.type !== 'issues.labeled') {
    ctx.log('info', 'ignoring unsupported event', { source: event.source, type: event.type });
    return;
  }

  const resource = asRecord(event.payload);
  const issue = maybeRecord(resource.issue) ?? resource;
  const fullName = stringValue(asRecord(resource.repository)?.full_name) ?? REPO_FULL_NAME;
  if (fullName !== REPO_FULL_NAME) {
    ctx.log('info', 'ignoring event for different repo', { fullName });
    return;
  }
  if (stringValue(issue.state ?? resource.state)?.toLowerCase() !== 'open') {
    ctx.log('info', 'skipping non-open issue', { eventId: event.id });
    return;
  }
  if (!readLabels(issue.labels ?? resource.labels).includes(LABEL)) {
    ctx.log('info', 'skipping issue without investigate label', { eventId: event.id });
    return;
  }

  const issueNumber = numberValue(issue.number ?? resource.number);
  if (!issueNumber) {
    ctx.log('warn', 'missing issue number', { eventId: event.id });
    return;
  }
  if (!ctx.github?.comment) {
    ctx.log('warn', 'ctx.github.comment unavailable; diagnosis dropped', { issueNumber });
    return;
  }

  const title = stringValue(issue.title) ?? `Issue #${issueNumber}`;
  const body = stringValue(issue.body) ?? '(no body)';
  const prompt = `Investigate ${REPO_FULL_NAME}#${issueNumber}. The repository is checked out at the current working directory; read the files you need.

Title: ${title}

Body:
${body}

Produce a 3-5 paragraph diagnosis. Cover, in order:
1. What the issue is asking for (restated in your own words).
2. Which files / modules in this repo are most relevant, with file paths.
3. The likely root cause (if a bug) or current behavior (if a feature ask).
4. A recommended approach with concrete next steps.

Ground every claim in code you read. Cite file paths and (where possible) line numbers. Do not speculate beyond what the code supports. Output ONLY the diagnosis — no preamble, no sign-off.`;

  const run = await ctx.harness.run({ cwd: ctx.sandbox.cwd, prompt });
  const diagnosis = (run.output ?? '').trim();
  if (!diagnosis) {
    ctx.log('warn', 'harness produced empty diagnosis; dropping comment', { issueNumber });
    return;
  }

  await ctx.github.comment(
    { owner: REPO_OWNER, repo: REPO_NAME, number: issueNumber },
    diagnosis
  );
  ctx.log('info', 'posted investigation diagnosis', { issueNumber, diagnosisLength: diagnosis.length });
});

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
}
function maybeRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}
function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function numberValue(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function readLabels(value: unknown): string[] {
  return Array.isArray(value) ? value.map((e) => String(asRecord(e).name ?? e).toLowerCase()) : [];
}
