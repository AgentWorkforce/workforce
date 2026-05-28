import { WorkforceIntegrationError } from '../errors.js';
import {
  draftFile,
  encodeSegment,
  type IntegrationClientOptions,
  listJsonFiles,
  readJsonFile,
  writeJsonFile
} from './request.js';

export type SlackThreadRef = string | { channel: string; ts: string };

/** A Slack channel as stored in the Relayfile VFS. */
export interface SlackChannel {
  id: string;
  name: string;
  isChannel?: boolean;
  isGroup?: boolean;
  isIm?: boolean;
  [key: string]: unknown;
}

/** A Slack user as stored in the Relayfile VFS. */
export interface SlackUser {
  id: string;
  name?: string;
  realName?: string;
  email?: string;
  [key: string]: unknown;
}

/** A Slack message as stored in the Relayfile VFS. */
export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  threadTs?: string;
  [key: string]: unknown;
}

export interface SlackClient {
  /** Post a message to a channel. */
  post(channel: string, text: string): Promise<{ channel: string; ts: string }>;
  /** Reply to a thread. */
  reply(threadTs: SlackThreadRef, text: string): Promise<{ channel: string; ts: string }>;
  /** Send a direct message to a user. */
  dm(user: string, text: string): Promise<{ channel: string; ts: string }>;
  /**
   * List all Slack channels the bot is a member of.
   * Reads `slack/channels/*.json`.
   */
  listChannels(): Promise<SlackChannel[]>;
  /**
   * List all Slack users visible to the bot.
   * Reads `slack/users/*.json`.
   */
  listUsers(): Promise<SlackUser[]>;
  /**
   * Get a single message by channel and ts.
   * Reads `slack/channels/<channelId>/messages/<ts>.json`.
   */
  getMessage(channel: string, ts: string): Promise<SlackMessage>;
  /**
   * Get all replies in a thread.
   * Reads `slack/channels/<channelId>/messages/<ts>/replies/*.json`.
   */
  getThreadMessages(channel: string, threadTs: string): Promise<SlackMessage[]>;
}

function parseThreadRef(threadTs: SlackThreadRef): { channel: string; ts: string } {
  if (typeof threadTs !== 'string') {
    if (!threadTs.channel.trim() || !threadTs.ts.trim()) {
      throw new WorkforceIntegrationError({
        provider: 'slack',
        operation: 'reply',
        cause: new Error('Slack reply threadTs must include non-empty channel and ts'),
        retryable: false
      });
    }
    return threadTs;
  }

  const [channel, ...rest] = threadTs.split(':');
  const ts = rest.join(':');
  if (!channel || !ts) {
    throw new WorkforceIntegrationError({
      provider: 'slack',
      operation: 'reply',
      cause: new Error('Slack reply threadTs must be { channel, ts } or "channel:ts"'),
      retryable: false
    });
  }
  return { channel, ts };
}

function tsPathSegment(ts: string): string {
  return encodeSegment(ts.replace(/\./g, '_'));
}

export function createSlackClient(opts: IntegrationClientOptions): SlackClient {
  return {
    async post(channel, text) {
      const result = await writeJsonFile(
        opts,
        'slack',
        'post',
        `/slack/channels/${encodeSegment(channel)}/messages/${draftFile('create message')}`,
        { text }
      );
      return { channel, ts: result.receipt?.created ?? result.receipt?.id ?? '' };
    },

    async reply(threadTs, text) {
      const thread = parseThreadRef(threadTs);
      const result = await writeJsonFile(
        opts,
        'slack',
        'reply',
        `/slack/channels/${encodeSegment(thread.channel)}/messages/${tsPathSegment(thread.ts)}/replies/${draftFile('create reply')}`,
        { text }
      );
      return { channel: thread.channel, ts: result.receipt?.created ?? result.receipt?.id ?? '' };
    },

    async dm(user, text) {
      const result = await writeJsonFile(
        opts,
        'slack',
        'dm',
        `/slack/users/${encodeSegment(user)}/messages/${draftFile('create dm')}`,
        { text }
      );
      return { channel: user, ts: result.receipt?.created ?? result.receipt?.id ?? '' };
    },

    async listChannels() {
      const files = await listJsonFiles<SlackChannel>(opts, 'slack', 'listChannels', '/slack/channels');
      return files.map((f) => f.value);
    },

    async listUsers() {
      const files = await listJsonFiles<SlackUser>(opts, 'slack', 'listUsers', '/slack/users');
      return files.map((f) => f.value);
    },

    getMessage(channel, ts) {
      return readJsonFile<SlackMessage>(opts, 'slack', 'getMessage', `/slack/channels/${encodeSegment(channel)}/messages/${tsPathSegment(ts)}.json`);
    },

    async getThreadMessages(channel, threadTs) {
      const files = await listJsonFiles<SlackMessage>(opts, 'slack', 'getThreadMessages', `/slack/channels/${encodeSegment(channel)}/messages/${tsPathSegment(threadTs)}/replies`);
      return files.map((f) => f.value);
    }
  };
}
