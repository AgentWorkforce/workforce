import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  MemoryItem,
  WorkforceCtx
} from '@agentworkforce/runtime';
import packageJson from '../package.json' with { type: 'json' };
import {
  conversationKey,
  conversationTag,
  createTurnRunner,
  defineTurnContext,
  defineTurnPersona,
  normalizeTurnHistory,
  runConfirmedTurnAction,
  TURN_KIT_VERSION,
  UnconfirmedTurnActionError,
  UnconfirmedTurnDeliveryError
} from './index.js';

test('package version and persona helper make durable memory visible', () => {
  assert.equal(TURN_KIT_VERSION, packageJson.version);
  const persona = defineTurnPersona({
    id: 'joke-bot',
    intent: 'relay-orchestrator',
    description: 'Keeps a conversation.',
    harnessSettings: { reasoning: 'low', timeoutSeconds: 300 },
    onEvent: './agent.ts',
    memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 }
  });
  assert.equal(persona.memory.ttlDays, 30);
});

test('conversation identity keeps transports and threads isolated', () => {
  assert.equal(conversationKey('C123'), 'C123');
  assert.equal(conversationKey('C123', '171.2'), 'C123:171.2');
  assert.equal(
    conversationTag('joke-bot', { transport: 'telegram', id: '8587:42' }),
    'turn:joke-bot:telegram:8587%3A42'
  );
  assert.notEqual(
    conversationTag('joke-bot', { transport: 'telegram', id: '8587' }),
    conversationTag('joke-bot', { transport: 'slack', id: '8587' })
  );
  assert.throws(
    () => conversationTag('Not Valid', { transport: 'telegram', id: '1' }),
    /lowercase slug/
  );
});

test('timestamped memory is always returned oldest first', () => {
  const history = normalizeTurnHistory([
    memoryItem('third', '2026-07-24T12:03:00.000Z'),
    memoryItem('first', '2026-07-24T12:01:00.000Z'),
    memoryItem('second', '2026-07-24T12:02:00.000Z')
  ]);
  assert.deepEqual(history.map((entry) => entry.content), ['first', 'second', 'third']);
});

test('timestamp-less cloud recall defaults from newest-first to chronological', () => {
  assert.deepEqual(
    normalizeTurnHistory(['newest', 'middle', 'oldest']).map((entry) => entry.content),
    ['oldest', 'middle', 'newest']
  );
  assert.deepEqual(
    normalizeTurnHistory(['oldest', 'newest'], 'oldest-first').map((entry) => entry.content),
    ['oldest', 'newest']
  );
});

test('runner composes recall, deterministic context, ack, delivery, then memory', async () => {
  const order: string[] = [];
  const saved: Array<{ content: string; tags?: string[] }> = [];
  const ctx = fakeCtx({
    recall: async () => {
      order.push('recall');
      return [
        memoryItem('User: old\nAssistant: earlier', '2026-07-24T12:00:00.000Z')
      ];
    },
    save: async (content, options) => {
      order.push('save');
      saved.push({ content, tags: options?.tags });
      return { id: 'mem-2' };
    }
  });
  const runner = createTurnRunner({
    namespace: 'life-agent',
    memory: {
      query: 'recent life-agent conversation',
      limit: 6,
      ttlSeconds: 3600,
      userLabel: 'Khaliq',
      assistantLabel: 'life-agent'
    },
    context: [
      defineTurnContext({
        name: 'task-store',
        collect: ({ history }) => {
          order.push('context');
          assert.equal(history[0]?.content, 'User: old\nAssistant: earlier');
          return {
            id: 'open-tasks',
            label: 'Open tasks',
            content: '#7 Call Mom',
            source: 'task-store',
            category: 'workspace'
          };
        }
      })
    ]
  });

  const result = await runner.run(ctx, {
    conversation: { transport: 'telegram', id: conversationKey('8587', 42) },
    input: 'remind me what is open',
    acknowledge: async (message) => {
      order.push('ack');
      assert.equal(message, 'Checking…');
    },
    respond: async ({ history, context, acknowledge }) => {
      order.push('respond');
      assert.equal(history.length, 1);
      assert.deepEqual(context, [{
        id: 'open-tasks',
        label: 'Open tasks',
        content: '#7 Call Mom',
        source: 'task-store',
        category: 'workspace'
      }]);
      assert.equal(await acknowledge('Checking…'), true);
      return 'You have one task: call Mom.';
    },
    deliver: async (reply) => {
      order.push('deliver');
      assert.match(reply, /call Mom/);
      return { ok: true, messageId: '99' };
    },
    confirmDelivery: (receipt) => receipt.ok
  });

  assert.deepEqual(order, ['recall', 'context', 'respond', 'ack', 'deliver', 'save']);
  assert.equal(result.memorySaved, true);
  assert.equal(result.acknowledgements, 1);
  assert.equal(saved[0]?.content, 'Khaliq: remind me what is open\nlife-agent: You have one task: call Mom.');
  assert.deepEqual(saved[0]?.tags, ['turn:life-agent:telegram:8587%3A42']);
});

test('unconfirmed delivery fails before memory can record a reply', async () => {
  let saves = 0;
  const ctx = fakeCtx({
    save: async () => {
      saves += 1;
      return { id: 'should-not-exist' };
    }
  });
  const runner = createTurnRunner({ namespace: 'receipt-safe' });
  await assert.rejects(
    () =>
      runner.run(ctx, {
        conversation: { transport: 'telegram', id: '1' },
        input: 'do it',
        respond: () => 'Done',
        deliver: async () => ({ ok: false }),
        confirmDelivery: (receipt) => receipt.ok
      }),
    UnconfirmedTurnDeliveryError
  );
  assert.equal(saves, 0);
});

test('action success text cannot be constructed before its provider receipt', async () => {
  let successCalls = 0;
  await assert.rejects(
    () =>
      runConfirmedTurnAction({
        name: 'create-task',
        perform: async () => ({ receipt: { status: 'queued' }, title: 'Call Mom' }),
        confirm: (result) => result.receipt.status === 'succeeded',
        confirmed: (result) => {
          successCalls += 1;
          return `Tracked: ${result.title}`;
        }
      }),
    UnconfirmedTurnActionError
  );
  assert.equal(successCalls, 0);

  const line = await runConfirmedTurnAction({
    name: 'create-task',
    perform: async () => ({ receipt: { status: 'succeeded' }, title: 'Call Mom' }),
    confirm: (result) => result.receipt.status === 'succeeded',
    confirmed: (result) => {
      successCalls += 1;
      return `Tracked: ${result.title}`;
    }
  });
  assert.equal(line, 'Tracked: Call Mom');
  assert.equal(successCalls, 1);
});

test('acknowledgement failure is best-effort and final delivery still completes', async () => {
  const logs: Array<{ level: string; message: string }> = [];
  const ctx = fakeCtx({}, logs);
  const result = await createTurnRunner({
    namespace: 'slow-agent',
    memory: false
  }).run(ctx, {
    conversation: { transport: 'slack', id: 'C1:T1' },
    input: 'look this up',
    acknowledge: async () => {
      throw new Error('no receipt');
    },
    respond: async ({ acknowledge }) => {
      assert.equal(await acknowledge('Looking…'), false);
      return 'Here is the result.';
    },
    deliver: async () => ({ ts: '123.4' })
  });
  assert.equal(result.acknowledgements, 0);
  assert.equal(result.memorySaved, false);
  assert.equal(
    logs.some((entry) => entry.message === 'turn-kit.acknowledgement-failed'),
    true
  );
});

test('required context fails closed while optional context degrades', async () => {
  let delivered = 0;
  const ctx = fakeCtx();
  const required = createTurnRunner({
    namespace: 'grounded-agent',
    memory: false,
    context: [
      defineTurnContext({
        name: 'exact-state',
        collect: async () => {
          throw new Error('state unavailable');
        }
      })
    ]
  });
  await assert.rejects(
    () =>
      required.run(ctx, {
        conversation: { transport: 'relay', id: 'peer' },
        input: 'what happened?',
        respond: () => 'should not run',
        deliver: async () => {
          delivered += 1;
        }
      }),
    /state unavailable/
  );
  assert.equal(delivered, 0);

  const optional = createTurnRunner({
    namespace: 'grounded-agent',
    memory: false,
    context: [
      defineTurnContext({
        name: 'nice-to-have',
        optional: true,
        collect: async () => {
          throw new Error('temporarily unavailable');
        }
      })
    ]
  });
  const result = await optional.run(ctx, {
    conversation: { transport: 'relay', id: 'peer' },
    input: 'hello',
    respond: ({ context }) => {
      assert.deepEqual(context, []);
      return { reply: 'Hello', remember: false };
    },
    deliver: async () => {
      delivered += 1;
    }
  });
  assert.equal(result.reply, 'Hello');
  assert.equal(delivered, 1);
});

test('missing memory save receipt is visible without failing a delivered chat turn', async () => {
  const logs: Array<{ level: string; message: string }> = [];
  const ctx = fakeCtx({ save: async () => undefined }, logs);
  const result = await createTurnRunner({ namespace: 'memory-aware' }).run(ctx, {
    conversation: { transport: 'telegram', id: '1' },
    input: 'hello',
    respond: () => 'Hi',
    deliver: async () => ({ ok: true }),
    confirmDelivery: (receipt) => receipt.ok
  });
  assert.equal(result.memorySaved, false);
  assert.equal(
    logs.some((entry) => entry.message === 'turn-kit.memory-save-unconfirmed'),
    true
  );
});

function memoryItem(content: string, createdAt: string): MemoryItem {
  return {
    id: `mem-${createdAt}`,
    content,
    tags: [],
    scope: 'workspace',
    createdAt
  };
}

function fakeCtx(
  memory: Partial<WorkforceCtx['memory']> = {},
  logs: Array<{ level: string; message: string }> = []
): WorkforceCtx {
  return {
    memory: {
      recall: memory.recall ?? (async () => []),
      save: memory.save ?? (async () => ({ id: 'mem-1' }))
    },
    log(level: string, message: string) {
      logs.push({ level, message });
    }
  } as unknown as WorkforceCtx;
}
