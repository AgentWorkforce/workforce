import type { IntegrationClientOptions } from '@agentworkforce/runtime/clients';
import { providerClient, type ProviderClient } from './provider-client.js';

/** Slack message timestamps contain `.`; the mount path encodes it as `_`. */
function tsParam(ts: string): string {
  return ts.replace(/\./g, '_');
}

export interface SlackClient extends ProviderClient<'slack'> {
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
 * Ergonomic Slack client over the writeback-path catalog, plus the uniform
 * resource-keyed access (`.messages`, `.["direct-messages"]`, `.replies`, `.reactions`).
 */
export function slackClient(opts: IntegrationClientOptions = {}): SlackClient {
  const base = providerClient('slack', opts);
  return Object.assign(base, {
    async post(channel: string, text: string) {
      const result = await base.messages.write({ channelId: channel }, { text });
      return { channel, ts: result.receipt?.created ?? result.receipt?.id ?? '' };
    },
    async dm(user: string, text: string) {
      const result = await base['direct-messages'].write({ userId: user }, { text });
      return { user, ts: result.receipt?.created ?? result.receipt?.id ?? '' };
    },
    async reply(channel: string, threadTs: string, text: string) {
      const result = await base.replies.write({ channelId: channel, messageTs: tsParam(threadTs) }, { text });
      return { channel, ts: result.receipt?.created ?? result.receipt?.id ?? '' };
    },
    async react(channel: string, messageTs: string, emoji: string) {
      await base.reactions.write({ channelId: channel, messageTs: tsParam(messageTs) }, { emoji });
    }
  }) as SlackClient;
}
