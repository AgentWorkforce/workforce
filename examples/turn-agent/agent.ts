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

    await turns.run(ctx, {
      conversation: {
        transport: 'relay',
        id: conversationKey(event.channel, event.threadId)
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
      deliver: (reply) => ctx.relay.post(event.channel!, reply),
      confirmDelivery: (receipt) => receipt.ok
    });
  }
});

function messageText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  const nested =
    record.message && typeof record.message === 'object' && !Array.isArray(record.message)
      ? record.message as Record<string, unknown>
      : {};
  return (
    typeof record.text === 'string'
      ? record.text
      : typeof nested.text === 'string'
        ? nested.text
        : ''
  ).trim();
}
