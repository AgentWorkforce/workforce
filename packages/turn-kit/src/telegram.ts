import type { WorkforceCtx } from '@agentworkforce/runtime';
import {
  bareTelegramChatId,
  defaultTelegramTransport,
  readTelegramMessage,
  sendTelegramText,
  telegramSkipReason,
  type TelegramInboundMessage,
  type TelegramTextReceipt,
  type TelegramTransport
} from '@agentworkforce/delivery';
import { conversationKey } from './memory.js';
import { createTurnRunner } from './runner.js';
import type {
  TurnResponderArgs,
  TurnResponse,
  TurnRunResult,
  TurnRunnerOptions
} from './types.js';

export interface TelegramTurnResponderArgs extends TurnResponderArgs {
  /** Normalized inbound message, including reply/thread context. */
  message: TelegramInboundMessage;
}

export interface TelegramTurnHandleInput {
  /** `event.expand("full").data`, a raw Bot API update, or normalized record. */
  payload: unknown;
  respond(
    args: TelegramTurnResponderArgs
  ): TurnResponse | string | Promise<TurnResponse | string>;
}

export type TelegramTurnHandleResult =
  | {
      status: 'handled';
      message: TelegramInboundMessage;
      result: TurnRunResult<TelegramTextReceipt>;
    }
  | {
      status: 'skipped';
      reason: string;
      message: TelegramInboundMessage | null;
    };

export interface TelegramTurnAdapterOptions
  extends TurnRunnerOptions {
  /** Owner chat id or a request-scoped resolver. Missing values fail closed. */
  ownerChat:
    | string
    | undefined
    | ((ctx: WorkforceCtx) => string | undefined);
  /** Optional transport seam for tests or non-Cloud runtimes. */
  transport?:
    | TelegramTransport
    | ((ctx: WorkforceCtx) => TelegramTransport);
}

export interface TelegramTurnAdapter {
  handle(
    ctx: WorkforceCtx,
    input: TelegramTurnHandleInput
  ): Promise<TelegramTurnHandleResult>;
}

/**
 * Bind Telegram's provider envelope and receipt semantics to the generic turn
 * lifecycle. Agents supply only their domain responder and context providers.
 */
export function createTelegramTurnAdapter(
  options: TelegramTurnAdapterOptions
): TelegramTurnAdapter {
  const runner = createTurnRunner(options);
  return {
    async handle(ctx, input) {
      const message = readTelegramMessage(input.payload);
      if (!message) {
        return {
          status: 'skipped',
          reason: 'unusable Telegram message',
          message: null
        };
      }
      const ownerChat =
        typeof options.ownerChat === 'function'
          ? options.ownerChat(ctx)
          : options.ownerChat;
      const reason = telegramSkipReason(message, ownerChat);
      if (reason) return { status: 'skipped', reason, message };

      const transport =
        typeof options.transport === 'function'
          ? options.transport(ctx)
          : options.transport ?? defaultTelegramTransport(ctx);
      const deliver = (text: string) => sendTelegramText(
        transport,
        message.chatId,
        text,
        {
          replyToMessageId: message.messageId,
          ...(message.threadId ? { threadId: message.threadId } : {})
        }
      );
      const result = await runner.run(ctx, {
        conversation: {
          transport: 'telegram',
          id: conversationKey(
            bareTelegramChatId(message.chatId),
            message.threadId
          )
        },
        input: message.text,
        respond: (args) => input.respond({ ...args, message }),
        acknowledge: deliver,
        deliver,
        confirmDelivery: (receipt) =>
          receipt.ok && receipt.messageIds.length > 0
      });
      return { status: 'handled', message, result };
    }
  };
}
