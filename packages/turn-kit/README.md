# @agentworkforce/turn-kit

Transport-neutral lifecycle primitives for multi-turn cloud agents. The kit
owns conversation identity, chronological memory, deterministic context
collection, interim acknowledgements, delivery confirmation, and post-delivery
persistence. The agent keeps control of event parsing, prompts, domain actions,
provider writes, and transport adapters.

```ts
import {
  conversationKey,
  createTurnRunner,
  defineTurnContext,
  defineTurnPersona
} from '@agentworkforce/turn-kit';

const turns = createTurnRunner({
  namespace: 'my-agent',
  memory: {
    query: 'recent my-agent conversation',
    limit: 8,
    ttlSeconds: 30 * 24 * 60 * 60,
    assistantLabel: 'my-agent'
  },
  context: [
    defineTurnContext({
      name: 'open-work',
      collect: async ({ ctx }) => ({
        title: 'Open work',
        content: await ctx.files.read('/my-agent/open-work.json')
      })
    })
  ]
});

await turns.run(ctx, {
  conversation: {
    transport: 'telegram',
    id: conversationKey(message.chatId, message.threadId)
  },
  input: message.text,
  acknowledge: (text) => telegram.reply(message, text),
  respond: async ({ input, history, context, acknowledge }) => {
    await acknowledge('Checking…');
    return ctx.llm.complete(buildPrompt({ input, history, context }));
  },
  deliver: (reply) => telegram.reply(message, reply),
  confirmDelivery: (receipt) => receipt.ok
});
```

Provider mutations can use `runConfirmedTurnAction()` so user-visible success
text is not even constructed until the receipt predicate passes:

```ts
const line = await runConfirmedTurnAction({
  ctx,
  name: 'create-github-task',
  perform: () => tasks.create(input),
  confirm: (result) => result.receipt.status === 'succeeded',
  confirmed: (result) => `📝 Tracked: ${result.title}`
});
```

Use `defineTurnPersona()` for the persona side. It is a pass-through factory
that requires enabled memory while leaving transports and every other persona
choice to the application:

```ts
export default defineTurnPersona({
  id: 'my-agent',
  intent: 'relay-orchestrator',
  description: 'A multi-turn assistant.',
  cloud: true,
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 },
  harnessSettings: { reasoning: 'low', timeoutSeconds: 300 },
  onEvent: './agent.ts'
});
```

## Lifecycle and guarantees

`createTurnRunner()` executes one turn in this order:

1. Recall only the matching transport + conversation tag and normalize history
   to oldest-first.
2. Run deterministic context providers. Required providers fail closed;
   optional providers warn and disappear.
3. Call the agent's responder. It may send best-effort, read-only
   acknowledgements for slow work.
4. Deliver the final reply and validate its receipt when
   `confirmDelivery` is supplied.
5. Save the user/reply pair only after confirmed delivery.

A final-delivery failure is never written into conversation history. A memory
save that returns no receipt is logged as `turn-kit.memory-save-unconfirmed`
and surfaced as `memorySaved: false`.

## What stays outside the kit

The following boundaries are deliberate:

- **Transport parsing and loop guards.** Slack, Telegram, relay inbox, and
  future surfaces have different envelopes and threading rules. Normalize them
  before calling the runner.
- **Domain actions.** GitHub issue writes, Linear mutations, reminders, and
  other side effects must wait for their provider receipt. Build success text
  from confirmed action results, then return it from `respond`.
  `runConfirmedTurnAction()` encodes this ordering without knowing the
  provider's receipt shape.
- **Exact operational or pending state.** Semantic memory is suitable for
  recent dialogue, not locks, idempotency, ordinals, or workflow state. Store
  those in a deterministic provider-backed/file record and expose them through
  a context provider.
- **Grounding policy.** The kit guarantees deterministic providers run before
  synthesis; each agent decides which sources are required and how to reconcile
  them.

These boundaries match the useful commonality across current agents:
life-agent's per-Telegram conversation and slow lookup acknowledgements,
joke-bot's callback memory, and hn-monitor's exact digest/thread grounding plus
live hydration. HN's exact state remains outside memory by design.

## Conversation identity

Use the transport's stable conversation boundary:

- Telegram: chat id plus forum-topic id.
- Slack: channel id plus root thread timestamp.
- Relay inbox: sender plus any application thread/correlation id.

`conversationKey(root, thread)` composes the transport-local id, and
`conversationTag(namespace, conversation)` adds namespace and transport
isolation.

## Partial adoption

Handlers do not have to use the full runner. `recallTurnHistory()`,
`rememberTurn()`, `collectTurnContext()`, and the conversation helpers are
public for agents with a custom lifecycle.
