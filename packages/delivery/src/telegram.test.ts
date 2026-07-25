import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkforceCtx } from '@agentworkforce/runtime';
import {
  bareTelegramChatId,
  chunkTelegramText,
  createCloudTelegramTransport,
  defaultTelegramTransport,
  readTelegramMessage,
  sendTelegramText,
  telegramSkipReason
} from './telegram.js';
import { createDelivery } from './delivery.js';

function context(fetchToken = true): WorkforceCtx {
  return {
    persona: {
      inputs: { TELEGRAM_CHAT: '8587455921__KJG Life Bot' },
      inputSpecs: {}
    },
    credentials: {
      cloudApi: fetchToken
        ? { url: 'https://cloud.example.test/cloud', token: 'workspace-token' }
        : { url: '', token: '' },
      relayfile: { url: '', token: '', workspaceId: '' },
      tryRequire() {
        return fetchToken
          ? {
              cloudApi: {
                url: 'https://cloud.example.test/cloud',
                token: 'workspace-token'
              },
              relayfile: { url: '', token: '', workspaceId: '' }
            }
          : null;
      },
      require() {
        throw new Error('unused');
      }
    },
    log: () => {}
  } as unknown as WorkforceCtx;
}

test('managed Telegram transport uses the Cloud proxy and requires a message id', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const transport = createCloudTelegramTransport(context(), {
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({
        ok: true,
        result: {
          message_id: 42,
          chat: { id: 8587455921 }
        }
      });
    }
  });
  assert.ok(transport);
  const result = await transport.sendMessage(
    '8587455921__KJG Life Bot',
    'hello',
    { replyToMessageId: 7, threadId: 9 }
  );

  assert.equal(
    requests[0]?.url,
    'https://cloud.example.test/cloud/api/v1/proxy/telegram'
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    endpoint: '/sendMessage',
    method: 'POST',
    data: {
      chat_id: 8587455921,
      text: 'hello',
      reply_to_message_id: 7,
      message_thread_id: 9
    }
  });
  assert.deepEqual(result, {
    ok: true,
    chatId: '8587455921',
    messageId: '42',
    ref: 'cloud:telegram:8587455921:42'
  });
});

test('managed Telegram transport rejects provider errors and missing receipts', async () => {
  const rejected = createCloudTelegramTransport(context(), {
    fetch: async () => Response.json(
      { ok: false, description: 'chat not found' },
      { status: 400 }
    )
  });
  await assert.rejects(
    rejected!.sendMessage('8587455921', 'hello'),
    /400.*chat not found/
  );

  const missing = createCloudTelegramTransport(context(), {
    fetch: async () => Response.json({ ok: true, result: {} })
  });
  await assert.rejects(
    missing!.sendMessage('8587455921', 'hello'),
    /no delivered message id/
  );
});

test('createDelivery prefers managed Telegram proxy credentials', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => Response.json({
    ok: true,
    result: { message_id: 42, chat: { id: 8587455921 } }
  });

  const delivery = createDelivery(context());
  const result = await delivery.send('hello');
  assert.deepEqual(result.refs, [{
    provider: 'telegram',
    chatId: '8587455921',
    messageId: '42'
  }]);
});

test('Telegram inbound parsing accepts Cloud webhook envelopes and fails closed', () => {
  const message = readTelegramMessage({
    data: {
      telegram: {
        chatId: '8587455921',
        messageId: '12',
        text: 'Add that',
        messageThreadId: '3',
        from: { is_bot: false }
      },
      message: {
        reply_to_message: { text: 'Call mom' }
      }
    }
  });
  assert.deepEqual(message, {
    chatId: '8587455921',
    messageId: '12',
    text: 'Add that',
    threadId: '3',
    replyText: 'Call mom',
    fromIsBot: false
  });
  assert.equal(telegramSkipReason(message!, undefined), 'no owner chat configured');
  assert.equal(telegramSkipReason(message!, 'other'), 'not the owner chat');
  assert.equal(telegramSkipReason(message!, '8587455921__title'), null);
});

test('Telegram helpers strip titles and chunk on line boundaries', () => {
  assert.equal(bareTelegramChatId('8587455921__KJG Life Bot'), '8587455921');
  assert.deepEqual(chunkTelegramText('12345\n67890', 7), ['12345', '67890']);
  assert.throws(() => chunkTelegramText('hello', 0), /positive integer/);
});

test('sendTelegramText threads the first chunk and requires every receipt', async () => {
  const calls: Array<{ text: string; options: unknown }> = [];
  const receipt = await sendTelegramText(
    {
      async sendMessage(chatId, text, options) {
        calls.push({ text, options });
        return {
          ok: true,
          chatId,
          messageId: String(calls.length),
          ref: `/telegram/${calls.length}`
        };
      }
    },
    '8587455921__title',
    '12345\n67890',
    { replyToMessageId: '7', threadId: '9', chunkLimit: 7 }
  );
  assert.deepEqual(receipt, {
    ok: true,
    chatId: '8587455921',
    messageIds: ['1', '2']
  });
  assert.deepEqual(calls, [
    {
      text: '12345',
      options: { replyToMessageId: '7', threadId: '9' }
    },
    { text: '67890', options: undefined }
  ]);

  await assert.rejects(
    sendTelegramText(
      {
        async sendMessage(chatId) {
          return { ok: false, chatId, messageId: '', ref: '' };
        }
      },
      '8587455921',
      'hello'
    ),
    /no receipt for chunk 1/
  );
});

test('defaultTelegramTransport prefers direct Cloud delivery', async () => {
  const transport = defaultTelegramTransport(context(), {
    fetch: async () => Response.json({
      ok: true,
      result: { message_id: 43, chat: { id: 8587455921 } }
    })
  });
  assert.equal(
    (await transport.sendMessage('8587455921', 'hello')).messageId,
    '43'
  );
});
