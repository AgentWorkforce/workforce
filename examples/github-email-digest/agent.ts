/**
 * github-email-digest — proactive agent handler.
 *
 * Runs on a schedule (3×/day). Each run it:
 *   1. Lists Gmail messages currently in the INBOX (read from the Relayfile
 *      VFS the `gmail` integration mounts at `/gmail/<account>/threads`).
 *   2. Archives any GitHub email you've *approved* — i.e. that you applied the
 *      approval label to in Gmail (default `Archive-Approved`). This is the
 *      "check with me before archiving" gate: the agent NEVER archives a
 *      message you didn't explicitly label.
 *   3. Summarizes the NEW GitHub emails since the last run (deduped via
 *      durable memory) and DMs you the digest on Slack, telling you to apply
 *      the approval label to anything you want filed away next cycle.
 *
 * Why a schedule and not a `google-mail` trigger? "Three times a day" is
 * inherently batched. The Gmail trigger events (`file.created` etc.) fire
 * per-message in real time, the opposite of a thrice-daily digest. For a
 * Slack-event-triggered companion, see ../slack-reaction-archiver.
 */
import { handler, type WorkforceCtx } from '@agentworkforce/runtime';

interface Config {
  slackUser: string;
  gmailAccount: string;
  approvalLabel: string;
  /** Senders that count as "from GitHub". Substring match, case-insensitive. */
  senders: string[];
  /** Prefix the Relayfile VFS is mounted under (RELAYFILE_MOUNT_ROOT). */
  mountRoot: string;
  /** VFS root for the Gmail provider — the connect registry calls it
   *  `google-mail` and mounts it at `/google-mail` (NOT `/gmail`). */
  gmailRoot: string;
  /** When true, compose + DM the digest but never write the archive. */
  dryRun: boolean;
  /** When true, DM a heartbeat even when there's nothing to report (test aid). */
  forceDm: boolean;
}

interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  labels: string[];
  /** VFS path the message was read from; archive writebacks target this. */
  path: string;
}

interface DigestState {
  /** Message ids already included in a previous digest (bounded ring). */
  notifiedIds: string[];
}

const STATE_TAG = 'gh-email-digest:state';

export default handler(async (ctx, event) => {
  if (event.source !== 'cron') {
    ctx.log('warn', 'gh-email-digest.ignored', { source: event.source });
    return;
  }
  if (!ctx.slack) throw new Error('gh-email-digest requires the slack integration (ctx.slack is undefined)');

  const cfg = readConfig(ctx);
  ctx.log('info', 'gh-email-digest.start', { schedule: event.name, account: cfg.gmailAccount });

  const inbox = await listInboxMessages(ctx, cfg);
  const fromGithub = inbox.filter((m) => isFromGithub(m, cfg.senders));
  ctx.log('info', 'gh-email-digest.scanned', { inbox: inbox.length, fromGithub: fromGithub.length });

  // ── 2. Archive the messages you approved (labelled) last cycle ───────────
  const approved = fromGithub.filter((m) => m.labels.includes(cfg.approvalLabel));
  const archived: GmailMessage[] = [];
  for (const m of approved) {
    try {
      if (!cfg.dryRun) await archiveMessage(ctx, m, cfg.approvalLabel);
      archived.push(m);
      ctx.log('info', 'gh-email-digest.archived', { id: m.id, subject: m.subject, dryRun: cfg.dryRun });
    } catch (err) {
      ctx.log('error', 'gh-email-digest.archive-failed', {
        id: m.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // ── 3. New GitHub emails since last run (skip ones already approved) ─────
  const state = await loadState(ctx);
  const approvedIds = new Set(approved.map((m) => m.id));
  const fresh = fromGithub.filter((m) => !state.notifiedIds.includes(m.id) && !approvedIds.has(m.id));

  if (fresh.length === 0 && archived.length === 0) {
    if (cfg.forceDm) {
      // Heartbeat: prove the Slack DM path works even on an empty inbox.
      await ctx.slack.dm(cfg.slackUser, renderDigest({ occurredAt: event.occurredAt, fresh, summary: '', archived, approvalLabel: cfg.approvalLabel }));
      ctx.log('info', 'gh-email-digest.heartbeat-dm', { user: cfg.slackUser });
    } else {
      ctx.log('info', 'gh-email-digest.nothing-to-report', {});
    }
    return;
  }

  const summary = fresh.length > 0 ? await summarize(ctx, fresh) : '';
  const dm = renderDigest({ occurredAt: event.occurredAt, fresh, summary, archived, approvalLabel: cfg.approvalLabel });
  await ctx.slack.dm(cfg.slackUser, dm);
  ctx.log('info', 'gh-email-digest.dm-sent', { user: cfg.slackUser, fresh: fresh.length, archived: archived.length });

  // ── 4. Persist the dedup checkpoint (bounded to the last 500 ids) ────────
  const notifiedIds = [...state.notifiedIds, ...fresh.map((m) => m.id)].slice(-500);
  await saveState(ctx, { notifiedIds });
});

function readConfig(ctx: WorkforceCtx): Config {
  const slackUser = input(ctx, 'SLACK_USER');
  if (!slackUser) throw new Error('SLACK_USER is required (your Slack user id, e.g. U0123ABCD)');
  const sendersRaw = input(ctx, 'GITHUB_SENDERS') ?? 'notifications@github.com,noreply@github.com,@github.com';
  return {
    slackUser,
    gmailAccount: input(ctx, 'GMAIL_ACCOUNT') ?? 'me',
    approvalLabel: input(ctx, 'APPROVAL_LABEL') ?? 'Archive-Approved',
    senders: sendersRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    mountRoot: process.env.RELAYFILE_MOUNT_ROOT?.replace(/\/$/, '') ?? '',
    gmailRoot: (input(ctx, 'GMAIL_VFS_ROOT') ?? '/google-mail').replace(/\/$/, ''),
    dryRun: (input(ctx, 'DRY_RUN') ?? '').toLowerCase() === 'true',
    forceDm: (input(ctx, 'FORCE_DM') ?? '').toLowerCase() === 'true'
  };
}

/** Resolve an input the same way other examples do: env var wins, then the
 *  persona's resolved input value, then its declared default. */
function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona.inputSpecs?.[name];
  const fromEnv = process.env[spec?.env ?? name];
  const value = (fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined) ?? ctx.persona.inputs?.[name] ?? spec?.default;
  return value && value.trim() ? value : undefined;
}

/** List every Gmail thread file under the mounted VFS and parse it. */
async function listInboxMessages(ctx: WorkforceCtx, cfg: Config): Promise<GmailMessage[]> {
  const dir = `${cfg.mountRoot}${cfg.gmailRoot}`;
  const { output, exitCode } = await ctx.sandbox.exec(
    `find ${shellQuote(dir)} -type f -name '*.json' 2>/dev/null || true`
  );
  if (exitCode !== 0 && !output.trim()) return [];
  const files = output.split('\n').map((l) => l.trim()).filter((l) => l && !l.endsWith('/_index.json') && !l.endsWith('/meta.json'));

  const messages: GmailMessage[] = [];
  for (const file of files) {
    try {
      const parsed = parseGmailFile(await ctx.files.read(file), file);
      // Only act on mail still in the inbox; everything else is already filed.
      messages.push(...parsed.filter((m) => m.labels.includes('INBOX')));
    } catch (err) {
      ctx.log('debug', 'gh-email-digest.parse-skip', { file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return messages;
}

/**
 * Tolerant parser for the Gmail VFS JSON. Handles a thread wrapper
 * (`{ id, messages: [...] }`), a single Gmail message resource
 * (`{ id, labelIds, snippet, payload: { headers } }`), and a flattened
 * `{ from, subject, snippet, labelIds }` shape.
 */
function parseGmailFile(content: string, path: string): GmailMessage[] {
  const root = JSON.parse(content) as Record<string, unknown>;
  const threadId = String(root.threadId ?? root.id ?? leafId(path));
  const raw = Array.isArray((root as { messages?: unknown }).messages)
    ? ((root as { messages: Record<string, unknown>[] }).messages)
    : [root];

  return raw.map((msg) => {
    const headers = readHeaders(msg) ?? readHeaders(root) ?? [];
    const header = (name: string) =>
      headers.find((h) => String(h.name).toLowerCase() === name)?.value ??
      asString((msg[name] ?? root[name]));
    const labels = (asArray(msg.labelIds) ?? asArray(root.labelIds) ?? []).map(String);
    return {
      id: String(msg.id ?? root.id ?? leafId(path)),
      threadId,
      from: header('from') ?? '',
      subject: header('subject') ?? '(no subject)',
      snippet: asString(msg.snippet ?? root.snippet) ?? '',
      labels,
      path
    } satisfies GmailMessage;
  });
}

function isFromGithub(m: GmailMessage, senders: string[]): boolean {
  const from = m.from.toLowerCase();
  return senders.some((s) => from.includes(s));
}

/** Archive = remove the INBOX label (and the approval label) via the Gmail
 *  modify writeback. Writing the body to the thread's VFS path makes
 *  Relayfile's writeback worker call `users/<account>/messages/<id>/modify`. */
async function archiveMessage(ctx: WorkforceCtx, m: GmailMessage, approvalLabel: string): Promise<void> {
  const body = JSON.stringify({ removeLabelIds: ['INBOX', approvalLabel] });
  await ctx.files.write(m.path, body);
}

async function summarize(ctx: WorkforceCtx, messages: GmailMessage[]): Promise<string> {
  const lines = messages
    .map((m, i) => `${i + 1}. From: ${m.from}\n   Subject: ${m.subject}\n   ${m.snippet}`)
    .join('\n\n');
  const prompt = [
    'You triage GitHub notification emails for a busy engineer. Below are new',
    'emails from GitHub. Write a TIGHT digest in Slack mrkdwn:',
    '- Group related notifications (same PR/issue/repo).',
    '- One bullet each, lead with the repo/PR/issue, then what happened and what (if anything) needs the reader.',
    '- Flag anything that looks like it needs a reply, a review, or a merge.',
    '- No preamble, no sign-off. Max ~8 bullets.',
    '',
    lines
  ].join('\n');
  try {
    return (await ctx.llm.complete(prompt, { maxTokens: 700 })).trim();
  } catch (err) {
    ctx.log('warn', 'gh-email-digest.summarize-failed', { error: err instanceof Error ? err.message : String(err) });
    return ''; // Fall back to the raw list rendered by renderDigest.
  }
}

function renderDigest(args: {
  occurredAt: string;
  fresh: GmailMessage[];
  summary: string;
  archived: GmailMessage[];
  approvalLabel: string;
}): string {
  const out: string[] = [`:envelope_with_arrow: *GitHub email digest* — ${new Date(args.occurredAt).toUTCString()}`];

  if (args.archived.length > 0) {
    out.push('', `:white_check_mark: Archived ${args.archived.length} message(s) you approved:`);
    for (const m of args.archived) out.push(`• ~${m.subject}~`);
  }

  if (args.fresh.length > 0) {
    out.push('', `:inbox_tray: *${args.fresh.length} new GitHub email(s)* still in your inbox:`);
    out.push(args.summary || args.fresh.map((m, i) => `${i + 1}. *${m.subject}* — ${m.from}`).join('\n'));
    out.push(
      '',
      `:point_right: To file these away: react :white_check_mark: to this message (the *slack-reaction-archiver* agent archives them all), or apply the *${args.approvalLabel}* label in Gmail for per-email control.`,
      `I never archive anything you haven't approved.`
    );
    // Machine-readable refs the slack-reaction-archiver scans for. Kept on one
    // muted line so the digest stays readable.
    out.push('', `_refs:_ ${args.fresh.map((m) => `[[gh:${m.threadId}]]`).join(' ')}`);
  } else {
    out.push('', ':sparkles: No new GitHub emails since the last digest.');
  }
  return out.join('\n');
}

async function loadState(ctx: WorkforceCtx): Promise<DigestState> {
  try {
    const items = await ctx.memory.recall(STATE_TAG, { tags: [STATE_TAG], limit: 1, scope: 'workspace' });
    const latest = items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (latest) {
      const parsed = JSON.parse(latest.content) as DigestState;
      if (Array.isArray(parsed.notifiedIds)) return parsed;
    }
  } catch {
    /* No prior state, or memory disabled — start fresh. Worst case we re-notify
       (safe); we never wrongly archive because approval lives in the Gmail label. */
  }
  return { notifiedIds: [] };
}

async function saveState(ctx: WorkforceCtx, state: DigestState): Promise<void> {
  try {
    await ctx.memory.save(JSON.stringify(state), { tags: [STATE_TAG], scope: 'workspace', ttlSeconds: 60 * 60 * 24 * 30 });
  } catch (err) {
    ctx.log('warn', 'gh-email-digest.state-save-failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── tiny helpers ───────────────────────────────────────────────────────────
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
function leafId(path: string): string {
  return path.split('/').pop()?.replace(/\.json$/, '') ?? 'unknown';
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function asArray(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}
function readHeaders(obj: unknown): Array<{ name: unknown; value: string }> | undefined {
  const payload = (obj as { payload?: { headers?: unknown } })?.payload;
  const headers = payload?.headers;
  if (!Array.isArray(headers)) return undefined;
  return headers
    .filter((h): h is { name: unknown; value: unknown } => typeof h === 'object' && h !== null)
    .map((h) => ({ name: h.name, value: asString(h.value) ?? '' }));
}
