import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  resolveMountRoot,
  type IntegrationClientOptions
} from '@agentworkforce/runtime';

// ── Inbound message handling ──────────────────────────────────────────────────
// Parallel to telegram.ts: readTelegramMessage / telegramSkipReason / bareTelegramChatId.

export interface SlackInboundMessage {
  channel: string;
  ts: string;
  threadTs?: string;
  text: string;
  user?: string;
  isBot: boolean;
  subtype?: string;
}

export interface SlackReaction {
  channel: string;
  messageTs: string;
  actorId: string;
  /** Normalized Slack emoji name without surrounding colons. */
  emoji: string;
  eventTs?: string;
}

function slackAsRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function slackStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Strip the `__name` suffix the platform appends to channel ids in some payloads
 * (e.g. `/slack/channels/{id__name}/**`). Bare Slack ids never contain `__`, so
 * this is a safe no-op when the id is already bare. Use it before comparing
 * channels, keying memory, or calling the Slack API.
 *
 * Parallel to `bareTelegramChatId` in telegram.ts.
 */
export function bareSlackChannelId(channel: string): string {
  return channel.split('__')[0];
}

/** Strip a leading `<@U…>`/`@name` mention so the question text is clean. */
export function stripSlackLeadingMention(text: string): string {
  return text.replace(/^\s*<@[^>]+>\s*/, '').replace(/^\s*@\S+\s*/, '');
}

/**
 * Conversation key for continuity. A threaded message keys on its thread; a
 * top-level message keys on the CHANNEL itself, so consecutive top-level
 * messages in a dedicated chat channel form one continuous conversation.
 */
export function conversationKeyForSlack(msg: SlackInboundMessage): string {
  const chanId = bareSlackChannelId(msg.channel);
  return msg.threadTs ? `${chanId}:${msg.threadTs}` : chanId;
}

/**
 * Parse a Slack message envelope into a normalized shape, or null if unusable.
 *
 * Parallel to `readTelegramMessage` in telegram.ts.
 */
export function readSlackMessage(payload: unknown): SlackInboundMessage | null {
  const rec = slackAsRecord(payload);
  if (!rec) return null;
  const unwrapped = slackAsRecord(rec.data) ?? rec;
  const raw = slackAsRecord(unwrapped.raw_event) ?? unwrapped;

  const channel = slackStr(unwrapped.channel) ?? slackStr(raw.channel);
  if (!channel) return null;
  const ts =
    slackStr(unwrapped.ts) ??
    slackStr(raw.ts) ??
    slackStr(unwrapped.event_ts) ??
    slackStr(raw.event_ts);
  if (!ts) return null;

  return {
    channel,
    ts,
    threadTs:
      slackStr(unwrapped.thread_ts) ??
      slackStr(unwrapped.threadTs) ??
      slackStr(raw.thread_ts),
    text: slackStr(unwrapped.text) ?? slackStr(raw.text) ?? '',
    user: slackStr(unwrapped.user) ?? slackStr(raw.user),
    isBot:
      Boolean(unwrapped.is_bot ?? raw.is_bot) ||
      Boolean(slackStr(unwrapped.bot_id) ?? slackStr(raw.bot_id)),
    subtype: slackStr(unwrapped.subtype) ?? slackStr(raw.subtype)
  };
}

/**
 * Parse a Slack reaction envelope into the exact message, actor, and emoji
 * needed by deterministic approval handlers.
 *
 * Cloud, Relayfile, and direct Slack fixtures have historically added
 * `data`, `event`, or `raw_event` wrappers. This parser accepts those known
 * shapes, but still requires an actor plus a message channel/timestamp and
 * rejects reactions to non-message items.
 */
export function readSlackReaction(payload: unknown): SlackReaction | null {
  const root = slackAsRecord(payload);
  if (!root) return null;
  const data = slackAsRecord(root.data) ?? root;
  const event = slackAsRecord(data.event) ?? data;
  const raw = slackAsRecord(event.raw_event) ?? slackAsRecord(data.raw_event) ?? event;
  const candidates = [raw, event, data, root];
  const item = firstSlackRecord(candidates, 'item');
  const itemType = slackStr(item?.type) ?? firstSlackString(candidates, 'item_type');
  if (itemType && itemType !== 'message') return null;

  const channel = slackStr(item?.channel) ?? firstSlackString(candidates, 'channel');
  // Do not fall back to a generic top-level `ts`: on raw reaction events that
  // can be the reaction event time rather than the reacted message. An item ts
  // or explicitly named message_ts is required for exact-message binding.
  const messageTs = slackStr(item?.ts) ?? firstSlackString(candidates, 'message_ts');
  const actorId = firstSlackString(candidates, 'user')
    ?? firstSlackString(candidates, 'user_id');
  const reaction = firstSlackString(candidates, 'reaction');
  if (!channel || !messageTs || !actorId || !reaction) return null;

  const emoji = reaction.trim().replaceAll(':', '');
  if (!emoji) return null;
  const eventTs = firstSlackString(candidates, 'event_ts');
  return {
    channel: bareSlackChannelId(channel),
    messageTs,
    actorId,
    emoji,
    ...(eventTs ? { eventTs } : {})
  };
}

/**
 * Return why an inbound Slack message must be ignored, or null to handle it.
 *
 * Skips bot messages (loop guard), message subtypes (edits, joins), the wrong
 * channel, and empty text. Does NOT check for a bot @mention — agents in shared
 * channels (pr-shepherd, joke-bot) should add that guard themselves: fail closed
 * when botUserId is unset, check `rawText.includes(\`<@${botUserId}>\`)`.
 *
 * Parallel to `telegramSkipReason` in telegram.ts.
 */
export function slackSkipReason(
  msg: SlackInboundMessage,
  boardChannel: string | undefined
): string | null {
  if (msg.isBot) return 'bot message';
  if (msg.subtype) return `slack subtype ${msg.subtype}`;
  if (!boardChannel || bareSlackChannelId(msg.channel) !== bareSlackChannelId(boardChannel)) {
    return 'not the chat channel';
  }
  if (!stripSlackLeadingMention(msg.text).trim()) return 'empty message text';
  return null;
}

// ── Roster helpers ─────────────────────────────────────────────────────────────

export interface SlackUser {
  id: string;
  handle: string;
  displayName: string;
}

export interface SlackMentionIndex {
  exactToId: Map<string, string>;
  firstNameToIds: Map<string, Set<string>>;
}

export interface SlackUsersWarning {
  code: 'users_directory_unavailable';
  path: string;
  error: string;
}

export interface SlackUsersOptions extends IntegrationClientOptions {
  onWarning?: (warning: SlackUsersWarning) => void;
}

interface SlackUserIndexRow {
  id?: unknown;
  name?: unknown;
  title?: unknown;
  is_bot?: unknown;
}

interface SlackUserRecord {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  real_name?: unknown;
  is_bot?: unknown;
}

/**
 * Load the human Slack roster from a Relayfile mount.
 *
 * The compact `_index.json` is preferred. When it is missing, malformed, or
 * contains no usable humans, this falls back to the per-member
 * `<id>__<handle>/meta.json` directories. Bots and Slackbot are excluded.
 */
export async function loadSlackUsers(opts: SlackUsersOptions): Promise<SlackUser[]> {
  const usersPath = path.join(resolveMountRoot(opts), 'slack', 'users');

  try {
    const rows = JSON.parse(
      await readFile(path.join(usersPath, '_index.json'), 'utf8')
    ) as unknown;
    if (Array.isArray(rows)) {
      const users = rows
        .filter(isSlackUserIndexRow)
        .filter((row) => row.is_bot !== true && !isSlackbot(row.id, row.name))
        .map((row) => ({
          id: row.id,
          handle: typeof row.name === 'string' ? row.name : '',
          displayName: typeof row.title === 'string' ? row.title : ''
        }))
        .filter((user) => user.handle.length > 0 || user.displayName.length > 0);
      if (users.length > 0) return users;
    }
  } catch {
    // Fall through to the per-member directory walk.
  }

  let entries: string[];
  try {
    entries = await readdir(usersPath);
  } catch (error) {
    opts.onWarning?.({
      code: 'users_directory_unavailable',
      path: usersPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }

  const users: SlackUser[] = [];
  for (const entry of entries) {
    if (
      entry.startsWith('_') ||
      entry.startsWith('.') ||
      entry === 'bots' ||
      entry === 'by-name'
    ) {
      continue;
    }

    let record: unknown;
    try {
      record = JSON.parse(
        await readFile(path.join(usersPath, entry, 'meta.json'), 'utf8')
      ) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    const user = record as SlackUserRecord;

    if (
      typeof user.id !== 'string' ||
      user.id.length === 0 ||
      user.is_bot === true ||
      isSlackbot(user.id, user.name)
    ) {
      continue;
    }

    users.push({
      id: user.id,
      handle: typeof user.name === 'string' ? user.name : '',
      displayName:
        typeof user.display_name === 'string' && user.display_name
          ? user.display_name
          : typeof user.real_name === 'string'
            ? user.real_name
            : ''
    });
  }
  return users;
}

/** Build exact and unambiguous-first-name lookups over a Slack roster. */
export function buildSlackMentionIndex(users: readonly SlackUser[]): SlackMentionIndex {
  const exactToId = new Map<string, string>();
  const firstNameToIds = new Map<string, Set<string>>();

  for (const user of users) {
    for (const field of [user.displayName, user.handle]) {
      if (!field) continue;
      const normalized = normalizeSlackMentionName(field);
      if (!normalized) continue;
      if (!exactToId.has(normalized)) exactToId.set(normalized, user.id);

      const firstToken = normalized.split(/\s+/)[0];
      if (firstToken && firstToken !== normalized) {
        const ids = firstNameToIds.get(firstToken) ?? new Set<string>();
        ids.add(user.id);
        firstNameToIds.set(firstToken, ids);
      }
    }
  }

  return { exactToId, firstNameToIds };
}

/** Resolve a human-supplied Slack handle/display name to a member id. */
export function resolveSlackUserId(name: string, index: SlackMentionIndex): string | null {
  const normalized = normalizeSlackMentionName(name);
  if (!normalized) return null;

  const exact = index.exactToId.get(normalized);
  if (exact) return exact;

  const firstNameIds = index.firstNameToIds.get(normalized);
  if (firstNameIds?.size === 1) {
    return firstNameIds.values().next().value ?? null;
  }
  return null;
}

/**
 * Rewrite plain `@handle` tokens as real Slack `<@ID>` mentions.
 *
 * Existing `<@ID>` mentions and email-address `@` signs are left alone;
 * unresolved handles remain verbatim and are returned for caller logging.
 */
export function linkSlackMentions(
  text: string,
  index: SlackMentionIndex
): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const linked = text.replace(
    /(?<![<\w])@([A-Za-z][A-Za-z0-9._-]*)/g,
    (full: string, handle: string) => {
      const id = resolveSlackUserId(handle, index);
      if (id) return `<@${id}>`;
      unresolved.push(handle);
      return full;
    }
  );
  return { text: linked, unresolved };
}

/** Format a sorted compact roster for prompts: `@handle — Display Name`. */
export function formatSlackRoster(users: readonly SlackUser[]): string {
  return users
    .filter((user) => user.handle.length > 0)
    .map((user) =>
      user.displayName ? `@${user.handle} — ${user.displayName}` : `@${user.handle}`
    )
    .sort((a, b) => a.localeCompare(b))
    .join('\n');
}

/** Return whether a value is an exact Slack channel/conversation id. */
export function isSlackChannelId(value: string): boolean {
  return /^[CDG][A-Z0-9]{8,}$/.test(value);
}

/** Require a delivered Slack timestamp instead of accepting a silent drop. */
export function requireSlackReceipt<T extends { channel: string; ts: string }>(result: T): T {
  if (!result.ts) {
    throw new Error(
      `Slack post to ${result.channel} got no writeback receipt (silent drop)`
    );
  }
  return result;
}

function isSlackUserIndexRow(value: unknown): value is SlackUserIndexRow & { id: string } {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && value.id.length > 0;
}

function firstSlackString(
  records: ReadonlyArray<Record<string, unknown>>,
  key: string
): string | undefined {
  for (const record of records) {
    const value = slackStr(record[key]);
    if (value) return value;
  }
  return undefined;
}

function firstSlackRecord(
  records: ReadonlyArray<Record<string, unknown>>,
  key: string
): Record<string, unknown> | null {
  for (const record of records) {
    const value = slackAsRecord(record[key]);
    if (value) return value;
  }
  return null;
}

function isSlackbot(id: unknown, handle: unknown): boolean {
  if (typeof id === 'string' && id.toUpperCase() === 'USLACKBOT') return true;
  return typeof handle === 'string' && handle.trim().toLowerCase() === 'slackbot';
}

function normalizeSlackMentionName(name: string): string {
  return name.trim().replace(/^@/, '').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
