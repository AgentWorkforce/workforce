import {
  defineAgent,
  isRelaycastMessageEvent,
  type AgentEvent
} from '@agentworkforce/runtime';
import {
  conversationKey,
  createTurnRunner
} from '@agentworkforce/turn-kit';

const turns = createTurnRunner({
  namespace: 'turn-agent-example',
  memory: {
    query: 'recent turn-agent-example conversation',
    limit: 8,
    ttlSeconds: 30 * 24 * 60 * 60,
    assistantLabel: 'turn-agent-example'
  }
});

export default defineAgent({
  handler: async (ctx, rawEvent) => {
    const event = rawEvent as unknown as AgentEvent;
    if (!isRelaycastMessageEvent(event) || !event.channel) return;
    const expanded = await event.expand('full');
    const input = messageText(expanded.data);
    if (!input) return;
    const directMessage = isDirectMessageChannel(event.channel);
    const peer = directMessage ? relayPeer(event, expanded.data) : undefined;
    if (directMessage && !peer) {
      ctx.log('warn', 'turn-agent.direct-peer-unavailable', { channel: event.channel });
      return;
    }

    await turns.run(ctx, {
      conversation: {
        transport: 'relay',
        id: directMessage
          ? conversationKey(event.channel, peer)
          : conversationKey(event.channel, event.threadId)
      },
      input,
      respond: async ({ history }) =>
        ctx.llm.complete(
          [
            'Answer clearly in at most four short lines.',
            history.length
              ? `Conversation so far (oldest first):\n${history.map((entry) => entry.content).join('\n')}`
              : '',
            `User: ${input}`
          ].filter(Boolean).join('\n\n'),
          { maxTokens: 300 }
        ),
      deliver: (reply) =>
        directMessage
          ? ctx.relay.dm(peer!, reply)
          : ctx.relay.post(event.channel!, reply),
      confirmDelivery: (receipt) => receipt.ok
    });
  }
});

function isDirectMessageChannel(channel: string): boolean {
  return channel === 'dm' || channel.startsWith('dm:');
}

function relayPeer(event: AgentEvent, data: unknown): string | undefined {
  const eventSummary = record((event as { summary?: unknown }).summary);
  const full = record(data);
  const candidates = [
    record(eventSummary?.actor),
    record(full?.from),
    record(full?.actor),
    record(record(full?.message)?.from),
    record(full?.message)
  ];
  for (const candidate of candidates) {
    const identity =
      text(candidate?.id) ??
      text(candidate?.agentId) ??
      text(candidate?.agent_id) ??
      text(candidate?.name) ??
      text(candidate?.displayName);
    if (identity) return identity;
  }
  return undefined;
}

function messageText(value: unknown): string {
  const recordValue = record(value);
  if (!recordValue) return '';
  const nested =
    recordValue.message && typeof recordValue.message === 'object' && !Array.isArray(recordValue.message)
      ? recordValue.message as Record<string, unknown>
      : {};
  return (
    typeof recordValue.text === 'string'
      ? recordValue.text
      : typeof nested.text === 'string'
        ? nested.text
        : ''
  ).trim();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
