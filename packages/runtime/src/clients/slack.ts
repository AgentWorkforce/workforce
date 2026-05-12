import { WorkforceIntegrationError } from '../errors.js';
import {
  draftFile,
  encodeSegment,
  type IntegrationClientOptions,
  writeJsonFile
} from './request.js';

export type SlackThreadRef = string | { channel: string; ts: string };

export interface SlackClient {
  post(channel: string, text: string): Promise<{ channel: string; ts: string }>;
  reply(threadTs: SlackThreadRef, text: string): Promise<{ channel: string; ts: string }>;
  dm(user: string, text: string): Promise<{ channel: string; ts: string }>;
}

function parseThreadRef(threadTs: SlackThreadRef): { channel: string; ts: string } {
  if (typeof threadTs !== 'string') {
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
    }
  };
}
