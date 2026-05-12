import { WorkforceIntegrationError } from '../errors.js';
import { providerRequest, type IntegrationClientOptions } from './request.js';

export type SlackThreadRef = string | { channel: string; ts: string };

export interface SlackClient {
  post(channel: string, text: string): Promise<{ channel: string; ts: string }>;
  reply(threadTs: SlackThreadRef, text: string): Promise<{ channel: string; ts: string }>;
  dm(user: string, text: string): Promise<{ channel: string; ts: string }>;
}

interface SlackResponse<T> {
  ok: boolean;
  error?: string;
  channel?: string | { id: string };
  ts?: string;
  message?: T;
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

function unwrapSlack(
  response: SlackResponse<unknown>,
  operation: string
): { channel: string; ts: string } {
  if (!response.ok || typeof response.channel !== 'string' || !response.ts) {
    throw new WorkforceIntegrationError({
      provider: 'slack',
      operation,
      cause: new Error(response.error ?? 'Slack response was missing channel or ts'),
      retryable: false
    });
  }
  return { channel: response.channel, ts: response.ts };
}

export function createSlackClient(opts: IntegrationClientOptions): SlackClient {
  const request = (operation: string, endpoint: string, body: unknown) => providerRequest<SlackResponse<{ id: string }>>({
    provider: 'slack',
    operation,
    client: opts,
    endpoint,
    body
  });

  return {
    async post(channel, text) {
      return unwrapSlack(await request('post', '/chat.postMessage', { channel, text }), 'post');
    },

    async reply(threadTs, text) {
      const thread = parseThreadRef(threadTs);
      return unwrapSlack(
        await request('reply', '/chat.postMessage', {
          channel: thread.channel,
          thread_ts: thread.ts,
          text
        }),
        'reply'
      );
    },

    async dm(user, text) {
      return unwrapSlack(await request('dm', '/chat.postMessage', { channel: user, text }), 'dm');
    }
  };
}
