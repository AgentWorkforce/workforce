import type { IntegrationClientOptions } from '@agentworkforce/runtime/clients';
import { relayClient } from './generic.js';

/** Slack message timestamps contain `.`; the mount path encodes it as `_`. */
function tsParam(ts: string): string {
  return ts.replace(/\./g, '_');
}

export interface SlackClient {
  /** Post a message to a channel. */
  post(channel: string, text: string): Promise<{ channel: string; ts: string }>;
  /** Direct-message a user. */
  dm(user: string, text: string): Promise<{ user: string; ts: string }>;
  /** Reply in a thread. */
  reply(channel: string, threadTs: string, text: string): Promise<{ channel: string; ts: string }>;
  /** React to a message. */
  react(channel: string, messageTs: string, emoji: string): Promise<void>;
}

/**
 * Ergonomic Slack client over the writeback-path catalog. Recovers the
 * `ctx.slack.post(...)` shape removed from the runtime.
 */
export function slackClient(opts: IntegrationClientOptions = {}): SlackClient {
  const relay = relayClient('slack', opts);
  return {
    async post(channel, text) {
      const result = await relay.write('messages', { channelId: channel }, { text });
      return { channel, ts: result.receipt?.created ?? result.receipt?.id ?? '' };
    },
    async dm(user, text) {
      const result = await relay.write('direct-messages', { userId: user }, { text });
      return { user, ts: result.receipt?.created ?? result.receipt?.id ?? '' };
    },
    async reply(channel, threadTs, text) {
      const result = await relay.write(
        'replies',
        { channelId: channel, messageTs: tsParam(threadTs) },
        { text }
      );
      return { channel, ts: result.receipt?.created ?? result.receipt?.id ?? '' };
    },
    async react(channel, messageTs, emoji) {
      await relay.write('reactions', { channelId: channel, messageTs: tsParam(messageTs) }, { emoji });
    }
  };
}
