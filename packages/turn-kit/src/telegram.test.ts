import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkforceCtx } from '@agentworkforce/runtime';
import type { TelegramTransport } from '@agentworkforce/delivery';
import { createTelegramTurnAdapter } from './telegram.js';

function fakeCtx(): WorkforceCtx {
  return {
    memory: {
      recall: async () => [],
      save: async () => ({ id: 'memory-1' })
    },
    log: () => {}
  } as unknown as WorkforceCtx;
}

test('Telegram turn adapter owns parsing, guard, threading, receipts, and memory', async () => {
  const sends: Array<{
    chatId: string | number;
    text: string;
    options: unknown;
  }> = [];
  const transport: TelegramTransport = {
    async sendMessage(chatId, text, options) {
      sends.push({ chatId, text, options });
      return {
        ok: true,
        chatId,
        messageId: String(40 + sends.length),
        ref: `/telegram/${sends.length}`
      };
    }
  };
  const adapter = createTelegramTurnAdapter({
    namespace: 'life-agent',
    ownerChat: '8587',
    transport
  });

  const handled = await adapter.handle(fakeCtx(), {
    payload: {
      telegram: {
        chatId: '8587__KJG Life Bot',
        messageId: '12',
        messageThreadId: '3',
        text: 'add that',
        from: { is_bot: false }
      },
      message: {
        reply_to_message: { text: 'Call mom' }
      }
    },
    respond: async ({ input, message, acknowledge }) => {
      assert.equal(input, 'add that');
      assert.equal(message.replyText, 'Call mom');
      assert.equal(await acknowledge('Working…'), true);
      return 'Done';
    }
  });

  assert.equal(handled.status, 'handled');
  if (handled.status !== 'handled') return;
  assert.equal(handled.result.memorySaved, true);
  assert.deepEqual(sends, [
    {
      chatId: '8587',
      text: 'Working…',
      options: { replyToMessageId: '12', threadId: '3' }
    },
    {
      chatId: '8587',
      text: 'Done',
      options: { replyToMessageId: '12', threadId: '3' }
    }
  ]);
});

test('Telegram turn adapter fails closed before the responder runs', async () => {
  let responses = 0;
  const adapter = createTelegramTurnAdapter({
    namespace: 'private-agent',
    ownerChat: undefined,
    transport: {
      async sendMessage(chatId) {
        return { ok: true, chatId, messageId: '1', ref: '/telegram/1' };
      }
    }
  });
  const result = await adapter.handle(fakeCtx(), {
    payload: {
      chatId: '8587',
      messageId: '12',
      text: 'secret',
      fromIsBot: false
    },
    respond: () => {
      responses += 1;
      return 'should not happen';
    }
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no owner chat configured');
  assert.equal(responses, 0);
});
