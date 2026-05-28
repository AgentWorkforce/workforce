import { handler } from '@agentworkforce/runtime';

/**
 * Minimal Mode 2 handler. One trigger -> one action.
 *
 * Listens for GitHub `issues.opened` / `issues.labeled` events on
 * AgentWorkforce/cloud. If the issue is open and carries the `hello`
 * label, posts a single confirmation comment via ctx.github.comment.
 * Anything else is ignored. No clone, no shell, no workflow.
 */

const REPO_OWNER = 'AgentWorkforce';
const REPO_NAME = 'cloud';
const REPO_FULL_NAME = `${REPO_OWNER}/${REPO_NAME}`;
const LABEL = 'hello';
const COMMENT_BODY =
  'hello from e2e-mode2-hello persona — Mode 2 E2E reached this handler.';

export default handler(async (ctx, event) => {
  if (event.source !== 'github') {
    ctx.log('info', 'ignoring unsupported event source', { source: event.source });
    return;
  }
  if (event.type !== 'issues.opened' && event.type !== 'issues.labeled') {
    ctx.log('info', 'ignoring non-issue event', { type: event.type });
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
    ctx.log('info', 'skipping issue without hello label', { labels, eventId: event.id });
    return;
  }

  const issueNumber = numberValue(issue.number ?? resource.number);
  if (!issueNumber) {
    ctx.log('warn', 'missing issue number', { eventId: event.id });
    return;
  }

  if (!ctx.github?.comment) {
    // Fail loud: a missing github.comment binding silently hides every effect
    // this persona produces. Surface it in cloud-web tail rather than appear
    // green-but-no-op.
    ctx.log('warn', 'ctx.github.comment unavailable; comment dropped', {
      issueNumber,
      bodyPreview: COMMENT_BODY.slice(0, 120)
    });
    return;
  }

  await ctx.github.comment(
    { owner: REPO_OWNER, repo: REPO_NAME, number: issueNumber },
    COMMENT_BODY
  );
  ctx.log('info', 'posted hello comment', { issueNumber });
});

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
