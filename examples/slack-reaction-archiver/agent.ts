/**
 * slack-reaction-archiver — react ✅ in Slack to archive GitHub emails.
 *
 * This persona is *triggered by a Slack event*: `reaction.added`. When you add
 * the configured emoji (default ✅ `white_check_mark`) to a message that
 * references GitHub emails — e.g. the digest DM from `../github-email-digest`,
 * which embeds `[[gh:<threadId>]]` tokens — this agent reads that message back
 * from the Relayfile Slack VFS, pulls out the token(s), and archives the
 * matching Gmail message(s) via the Gmail `modify` writeback.
 *
 * It's the Slack-native half of "check with me before archiving": you approve
 * by reacting in the chat instead of labelling in Gmail.
 */
import { handler, type WorkforceCtx } from '@agentworkforce/runtime';

interface SlackReactionEvent {
  user?: string;
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
}

const TOKEN_RE = /\[\[gh:([A-Za-z0-9_-]+)\]\]/g;

export default handler(async (ctx, event) => {
  if (event.source !== 'slack') return;
  // Two triggers, two opposite actions: ✅ archives, un-✅ restores to inbox.
  const action: 'archive' | 'restore' | null =
    event.type === 'reaction.added' ? 'archive' : event.type === 'reaction.removed' ? 'restore' : null;
  if (action === null) return;
  const cfg = readConfig(ctx);

  const payload = (typeof event.payload === 'object' && event.payload ? event.payload : {}) as SlackReactionEvent;
  const reaction = (payload.reaction ?? '').replace(/:/g, '');
  if (reaction !== cfg.emoji) {
    ctx.log('debug', 'slack-archiver.ignored-emoji', { reaction, want: cfg.emoji });
    return;
  }
  const channel = payload.item?.channel;
  const ts = payload.item?.ts;
  if (payload.item?.type !== 'message' || !channel || !ts) {
    ctx.log('debug', 'slack-archiver.not-a-message-reaction', { item: payload.item });
    return;
  }

  const text = await readSlackMessageText(ctx, channel, ts);
  if (text === undefined) {
    ctx.log('warn', 'slack-archiver.message-unreadable', { channel, ts });
    return; // Can't see the message → never guess what to archive.
  }

  const threadIds = [...new Set([...text.matchAll(TOKEN_RE)].map((m) => m[1]))];
  if (threadIds.length === 0) {
    ctx.log('info', 'slack-archiver.no-tokens', { channel, ts });
    return;
  }

  const done: string[] = [];
  for (const id of threadIds) {
    try {
      if (!cfg.dryRun) await modifyThread(ctx, cfg.gmailAccount, id, action);
      done.push(id);
      ctx.log('info', `slack-archiver.${action}d`, { threadId: id, dryRun: cfg.dryRun });
    } catch (err) {
      ctx.log('error', `slack-archiver.${action}-failed`, { threadId: id, error: errMsg(err) });
    }
  }

  if (done.length > 0 && ctx.slack) {
    const verb = action === 'archive' ? 'Archived' : 'Restored to inbox';
    const icon = action === 'archive' ? ':file_cabinet:' : ':inbox_tray:';
    await ctx.slack.reply(
      { channel, ts },
      `${icon} ${verb} ${done.length} GitHub email${done.length === 1 ? '' : 's'}${cfg.dryRun ? ' _(dry-run — nothing written)_' : ''}.`
    );
  }
});

interface Config {
  emoji: string;
  gmailAccount: string;
  mountRoot: string;
  dryRun: boolean;
}

function readConfig(ctx: WorkforceCtx): Config {
  return {
    emoji: (input(ctx, 'EMOJI') ?? 'white_check_mark').replace(/:/g, ''),
    gmailAccount: input(ctx, 'GMAIL_ACCOUNT') ?? 'me',
    mountRoot: process.env.RELAYFILE_MOUNT_ROOT?.replace(/\/$/, '') ?? '',
    dryRun: (input(ctx, 'DRY_RUN') ?? '').toLowerCase() === 'true'
  };
}

/** Read the reacted message's text from the Relayfile Slack VFS. The reaction
 *  event only carries channel + ts, so we fetch the message body by path. */
async function readSlackMessageText(ctx: WorkforceCtx, channel: string, ts: string): Promise<string | undefined> {
  const root = process.env.RELAYFILE_MOUNT_ROOT?.replace(/\/$/, '') ?? '';
  // DM channels are addressed under /slack/users; public/private channels under
  // /slack/channels. Try the channel path first, then a couple of fallbacks.
  const candidates = [
    `${root}/slack/channels/${channel}/messages/${ts}.json`,
    `${root}/slack/channels/${channel}/messages/${ts}/meta.json`,
    `${root}/slack/users/${channel}/messages/${ts}.json`
  ];
  for (const path of candidates) {
    try {
      const raw = await ctx.files.read(path);
      const text = extractText(raw);
      if (text !== undefined) return text;
    } catch {
      /* try next candidate */
    }
  }
  return undefined;
}

function extractText(raw: string): string | undefined {
  const msg = JSON.parse(raw) as Record<string, unknown>;
  if (typeof msg.text === 'string') return msg.text;
  // Slack messages can carry their body in blocks; fall back to a flat scan.
  if (Array.isArray(msg.blocks)) return JSON.stringify(msg.blocks);
  return undefined;
}

/** Archive = remove INBOX; restore = add INBOX. Both go through the Gmail
 *  modify writeback (writing to the thread's VFS path). Mirrors
 *  ../github-email-digest/agent.ts. */
async function modifyThread(ctx: WorkforceCtx, account: string, threadId: string, action: 'archive' | 'restore'): Promise<void> {
  const root = process.env.RELAYFILE_MOUNT_ROOT?.replace(/\/$/, '') ?? '';
  const path = `${root}/gmail/${encodeURIComponent(account)}/threads/${encodeURIComponent(threadId)}.json`;
  const body = action === 'archive' ? { removeLabelIds: ['INBOX'] } : { addLabelIds: ['INBOX'] };
  await ctx.files.write(path, JSON.stringify(body));
}

function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona.inputSpecs?.[name];
  const fromEnv = process.env[spec?.env ?? name];
  const value = (fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined) ?? ctx.persona.inputs?.[name] ?? spec?.default;
  return value && value.trim() ? value : undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
