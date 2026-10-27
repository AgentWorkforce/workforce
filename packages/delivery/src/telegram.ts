import type {
  TelegramChatId,
  TelegramMessageResult,
  TelegramSendMessageOptions
} from '@relayfile/relay-helpers';
import { telegramClient } from '@relayfile/relay-helpers';
import type { WorkforceCtx } from '@agentworkforce/runtime';

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const TELEGRAM_MESSAGE_LIMIT = 4_096;

export interface TelegramTransport {
  sendMessage(
    chatId: TelegramChatId,
    text: string,
    options?: TelegramSendMessageOptions
  ): Promise<TelegramMessageResult>;
}

export interface CloudTelegramTransportOptions {
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface DefaultTelegramTransportOptions
  extends CloudTelegramTransportOptions {
  writebackTimeoutMs?: number;
}

export interface TelegramTextReceipt {
  ok: true;
  chatId: string;
  messageIds: string[];
}

export interface TelegramInboundMessage {
  chatId: string;
  messageId: string;
  text: string;
  threadId?: string;
  replyText?: string;
  fromIsBot: boolean;
}

/**
 * Resolve a direct Telegram sender from managed Cloud credentials.
 *
 * Telegram writeback is not universally available in Relayfile. Managed
 * deployments therefore use Cloud's provider proxy and require the Bot API's
 * delivered message id before resolving.
 */
export function createCloudTelegramTransport(
  ctx: WorkforceCtx,
  options: CloudTelegramTransportOptions = {}
): TelegramTransport | undefined {
  const credentials = cloudCredentials(ctx);
  if (!credentials) return undefined;
  const endpoint =
    `${credentials.url.replace(/\/+$/, '')}/api/v1/proxy/telegram`;
  const fetchImpl = options.fetch ?? fetch;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    async sendMessage(chatId, text, sendOptions = {}) {
      const replyToMessageId = numericMessageId(
        sendOptions.replyToMessageId
      );
      const threadId = numericMessageId(sendOptions.threadId);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${credentials.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            endpoint: '/sendMessage',
            method: 'POST',
            data: {
              chat_id: numericChatId(chatId),
              text,
              ...(replyToMessageId !== undefined
                ? { reply_to_message_id: replyToMessageId }
                : {}),
              ...(threadId !== undefined
                ? { message_thread_id: threadId }
                : {}),
              ...(sendOptions.parseMode
                ? { parse_mode: sendOptions.parseMode }
                : {}),
              ...(sendOptions.disableWebPagePreview !== undefined
                ? {
                    disable_web_page_preview:
                      sendOptions.disableWebPagePreview
                  }
                : {}),
              ...(sendOptions.disableNotification !== undefined
                ? { disable_notification: sendOptions.disableNotification }
                : {}),
              ...(sendOptions.replyMarkup
                ? { reply_markup: sendOptions.replyMarkup }
                : {}),
              ...(sendOptions.businessConnectionId
                ? {
                    business_connection_id:
                      sendOptions.businessConnectionId
                  }
                : {})
            }
          }),
          signal: controller.signal
        });
      } catch (error) {
        if (isAbortError(error)) {
          throw new Error(
            `Telegram Cloud proxy timed out after ${requestTimeoutMs}ms`
          );
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }

      const body = await response.json().catch(() => null) as
        | Record<string, unknown>
        | null;
      if (!response.ok || body?.ok === false) {
        const detail = String(
          body?.error ?? body?.description ?? body?.code ?? `HTTP ${response.status}`
        ).slice(0, 240);
        throw new Error(
          `Telegram Cloud proxy failed (${response.status}): ${detail}`
        );
      }
      const result = asRecord(body?.result) ?? body;
      const messageId = scalar(result?.message_id ?? result?.messageId);
      if (!messageId) {
        throw new Error('Telegram Cloud proxy returned no delivered message id');
      }
      const deliveredChat =
        scalar(asRecord(result?.chat)?.id ?? result?.chat_id) ??
        String(chatId);
      return {
        ok: true,
        chatId: deliveredChat,
        messageId,
        ref: `cloud:telegram:${deliveredChat}:${messageId}`
      };
    }
  };
}

/**
 * Select the strongest available Telegram transport.
 *
 * Managed Cloud uses direct proxy delivery. Other runtimes retain the
 * Relayfile writeback client, explicitly configured for HTTP when credentials
 * are available so a local mount cannot silently swallow drafts.
 */
export function defaultTelegramTransport(
  ctx: WorkforceCtx,
  options: DefaultTelegramTransportOptions = {}
): TelegramTransport {
  const direct = createCloudTelegramTransport(ctx, options);
  if (direct) return direct;
  return createRelayfileTelegramTransport(ctx, options);
}

/** Create a Relayfile Telegram sender with explicit managed HTTP credentials. */
export function createRelayfileTelegramTransport(
  ctx: WorkforceCtx,
  options: Pick<DefaultTelegramTransportOptions, 'writebackTimeoutMs'> = {}
): TelegramTransport {
  return telegramClient({
    writebackTimeoutMs: options.writebackTimeoutMs ?? 45_000,
    ...relayfileHttpOptions(ctx)
  });
}

/**
 * Deliver all Telegram chunks and require a provider receipt for every chunk.
 * The first chunk may be threaded under the inbound message/topic.
 */
export async function sendTelegramText(
  transport: TelegramTransport,
  chatId: string | number,
  text: string,
  options: {
    replyToMessageId?: string | number;
    threadId?: string | number;
    chunkLimit?: number;
  } = {}
): Promise<TelegramTextReceipt> {
  const target = bareTelegramChatId(chatId);
  const messageIds: string[] = [];
  for (const [index, chunk] of chunkTelegramText(
    text,
    options.chunkLimit
  ).entries()) {
    const result = await transport.sendMessage(
      target,
      chunk,
      index === 0
        ? {
            ...(options.replyToMessageId !== undefined
              ? { replyToMessageId: options.replyToMessageId }
              : {}),
            ...(options.threadId !== undefined
              ? { threadId: options.threadId }
              : {})
          }
        : undefined
    );
    if (!result.ok || !result.messageId) {
      throw new Error(
        `Telegram delivery to ${target} returned no receipt for chunk ${index + 1}`
      );
    }
    messageIds.push(String(result.messageId));
  }
  return { ok: true, chatId: target, messageIds };
}

/** Parse Cloud webhook, raw Bot API, and Relayfile Telegram envelopes. */
export function readTelegramMessage(payload: unknown): TelegramInboundMessage | null {
  const root = asRecord(payload);
  if (!root) return null;
  const envelope = asRecord(root.data) ?? root;
  const normalized = asRecord(envelope.telegram) ?? asRecord(root.telegram);
  const rawMessage =
    asRecord(envelope.message) ??
    asRecord(envelope.edited_message) ??
    asRecord(envelope.business_message) ??
    asRecord(envelope.channel_post);
  const data = normalized ?? rawMessage ?? envelope;
  const from = asRecord(rawMessage?.from) ?? asRecord(data.from);
  const chat = asRecord(rawMessage?.chat) ?? asRecord(data.chat);
  const reply = asRecord(rawMessage?.reply_to_message);
  const chatId = scalar(data.chatId) ?? scalar(chat?.id);
  const messageId = scalar(data.messageId) ?? scalar(data.message_id);
  if (!chatId || !messageId) return null;
  return {
    chatId,
    messageId,
    text:
      scalar(data.text) ??
      scalar(rawMessage?.text) ??
      scalar(data.caption) ??
      scalar(rawMessage?.caption) ??
      '',
    threadId:
      scalar(data.messageThreadId) ??
      scalar(data.message_thread_id) ??
      scalar(rawMessage?.message_thread_id),
    replyText: scalar(reply?.text) ?? scalar(reply?.caption),
    fromIsBot: Boolean(from?.is_bot ?? data.fromIsBot)
  };
}

/**
 * Return why an inbound Telegram message must be ignored.
 *
 * Owner filtering fails closed: an absent owner chat never means "all chats".
 */
export function telegramSkipReason(
  message: TelegramInboundMessage,
  ownerChat: string | undefined
): string | null {
  if (message.fromIsBot) return 'bot message';
  if (!ownerChat?.trim()) return 'no owner chat configured';
  if (bareTelegramChatId(message.chatId) !== bareTelegramChatId(ownerChat)) {
    return 'not the owner chat';
  }
  if (!message.text.trim()) return 'empty message text';
  return null;
}

export function bareTelegramChatId(value: string | number): string {
  return String(value).split('__')[0]?.trim() ?? '';
}

/** Split long messages on line boundaries without exceeding Telegram's limit. */
export function chunkTelegramText(
  text: string,
  limit = TELEGRAM_MESSAGE_LIMIT
): string[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError('Telegram chunk limit must be a positive integer');
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let split = remaining.lastIndexOf('\n', limit);
    if (split < Math.floor(limit / 2)) split = limit;
    chunks.push(remaining.slice(0, split).trimEnd());
    remaining = remaining.slice(split).replace(/^\n/u, '');
  }
  if (remaining || chunks.length === 0) chunks.push(remaining);
  return chunks;
}

function cloudCredentials(
  ctx: WorkforceCtx
): { url: string; token: string } | undefined {
  try {
    const required = ctx.credentials?.tryRequire?.();
    const cloud = required?.cloudApi ?? ctx.credentials?.cloudApi;
    if (!cloud?.url?.trim() || !cloud.token?.trim()) return undefined;
    return { url: cloud.url.trim(), token: cloud.token.trim() };
  } catch {
    return undefined;
  }
}

function relayfileHttpOptions(
  ctx: WorkforceCtx
): Record<string, string> {
  try {
    const required = ctx.credentials?.tryRequire?.();
    const relayfile = required?.relayfile ?? ctx.credentials?.relayfile;
    if (
      !relayfile?.url?.trim() ||
      !relayfile.token?.trim() ||
      !relayfile.workspaceId?.trim()
    ) {
      return {};
    }
    return {
      relayfileBaseUrl: relayfile.url.trim(),
      relayfileApiToken: relayfile.token.trim(),
      workspaceId: relayfile.workspaceId.trim()
    };
  } catch {
    return {};
  }
}

function numericChatId(value: string | number): string | number {
  const bare = bareTelegramChatId(value);
  const number = Number(bare);
  return Number.isSafeInteger(number) ? number : bare;
}

function numericMessageId(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && !/^\d+$/u.test(value.trim())) {
    return undefined;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
