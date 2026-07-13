import { slackClient, telegramClient } from '@relayfile/relay-helpers';
import type { SlackClient, TelegramClient } from '@relayfile/relay-helpers';
import type { WorkforceCtx } from '@agentworkforce/runtime';
import {
  resolveDeliveryTargets,
  slackChannel,
  telegramChat,
  type DeliveryClient,
  type DeliveryOptions,
  type DeliveryProvider,
  type DeliveryResult,
  type DeliveryTransports,
  type RelaycastRef,
  type RelaycastSender,
  type SlackRef,
  type TelegramRef
} from './types.js';
import { defaultRelaycastSender } from './relaycast.js';

const WRITEBACK_TIMEOUT_MS = 45_000;

/**
 * Create a delivery client that auto-discovers configured transports from
 * the persona context and sends to all of them.
 *
 * Blocking mode (the default):
 *   const heads = await delivery.send(header);
 *   await delivery.send(body, { replyTo: heads });
 *
 * Non-blocking parentRef mode (zero receipt round-trips):
 *   const heads = await delivery.publish(header);
 *   await delivery.send(body, { replyTo: heads, nonBlocking: true });
 *
 * Pass `transports` to inject mock clients for testing — the same injected
 * client is used for both blocking and non-blocking paths (tests supply
 * their own mock that short-circuits the writeback).
 */
export function createDelivery(
  ctx: WorkforceCtx,
  transports?: DeliveryTransports,
  /** Override which transports to target (defaults to all configured). */
  onlyTargets?: ReadonlyArray<DeliveryProvider>
): DeliveryClient {
  // Slack/Telegram are config-driven (persona inputs). Relaycast is event-driven
  // — it's a target only when the caller supplies a reply address in transports.
  const allTargets: DeliveryProvider[] = [...resolveDeliveryTargets(ctx)];
  if (transports?.relaycast?.to) allTargets.push('relaycast');
  const targets = onlyTargets
    ? allTargets.filter((t) => (onlyTargets as readonly string[]).includes(t))
    : allTargets;

  // Injected transports take priority. When not injected, construct real
  // clients with appropriate timeouts.
  const injectedSlack = transports?.slack;
  const injectedTelegram = transports?.telegram;

  const slackBlocking = injectedSlack ?? (targets.includes('slack')
    ? slackClient({ writebackTimeoutMs: WRITEBACK_TIMEOUT_MS })
    : undefined);
  const slackNonBlocking = injectedSlack ?? (targets.includes('slack')
    ? slackClient({ writebackTimeoutMs: 0 })
    : undefined);
  const telegramBlocking = injectedTelegram ?? (targets.includes('telegram')
    ? telegramClient({ writebackTimeoutMs: WRITEBACK_TIMEOUT_MS })
    : undefined);
  const telegramNonBlocking = injectedTelegram ?? (targets.includes('telegram')
    ? telegramClient({ writebackTimeoutMs: 0 })
    : undefined);

  // Relaycast reply: address from the inbound event, client from the injected
  // sender or the default env-backed one (POST /v1/dm with RELAY_API_KEY).
  const relaycast = targets.includes('relaycast') && transports?.relaycast?.to
    ? {
        to: transports.relaycast.to,
        sender: transports.relaycast.sender ?? defaultRelaycastSender(ctx)
      }
    : undefined;

  return new DeliveryClientImpl(ctx, targets, {
    slackBlocking,
    slackNonBlocking,
    telegramBlocking,
    telegramNonBlocking,
    relaycast
  });
}

interface DeliveryTransportsInternal {
  slackBlocking?: SlackClient;
  slackNonBlocking?: SlackClient;
  telegramBlocking?: TelegramClient;
  telegramNonBlocking?: TelegramClient;
  relaycast?: { to: string; sender: RelaycastSender };
}

class DeliveryClientImpl implements DeliveryClient {
  readonly targets: ReadonlyArray<DeliveryProvider>;

  private ctx: WorkforceCtx;
  private t: DeliveryTransportsInternal;

  constructor(
    ctx: WorkforceCtx,
    targets: Array<DeliveryProvider>,
    transports: DeliveryTransportsInternal
  ) {
    this.ctx = ctx;
    this.targets = targets;
    this.t = transports;
  }

  async send(text: string, opts?: DeliveryOptions): Promise<DeliveryResult> {
    const nonBlocking = opts?.nonBlocking === true;
    const refs: Array<SlackRef | TelegramRef | RelaycastRef> = [];
    const errors: string[] = [];

    const tasks: Promise<void>[] = [];

    for (const target of this.targets) {
      const parentRef = opts?.replyTo?.refs.find((r) => r.provider === target);
      if (target === 'slack') {
        tasks.push(
          this.sendSlack(text, parentRef as SlackRef | undefined, nonBlocking)
            .then((ref) => { if (ref) refs.push(ref); })
            .catch((err) => { errors.push(`slack: ${String(err)}`); })
        );
      }
      if (target === 'telegram') {
        tasks.push(
          this.sendTelegram(text, parentRef as TelegramRef | undefined, nonBlocking)
            .then((ref) => { if (ref) refs.push(ref); })
            .catch((err) => { errors.push(`telegram: ${String(err)}`); })
        );
      }
      if (target === 'relaycast') {
        // Relaycast replies are a single blocking DM — there's no draft-ref /
        // server-ordered threading pattern, so they don't participate in
        // publish()/non-blocking sends (which promise no receipt wait).
        if (nonBlocking) {
          this.ctx.log?.('debug', 'delivery.relaycast.skip-nonblocking', { to: this.t.relaycast?.to });
          continue;
        }
        tasks.push(
          this.sendRelaycast(text)
            .then((ref) => { if (ref) refs.push(ref); })
            .catch((err) => { errors.push(`relaycast: ${String(err)}`); })
        );
      }
    }

    await Promise.all(tasks);

    // In non-blocking mode, draft refs always succeed (no receipt wait to fail).
    // Treat any ref as success. In blocking mode, require all targets to succeed.
    const ok = nonBlocking
      ? refs.length > 0
      : errors.length === 0 && refs.length === this.targets.length;

    if (!ok && errors.length > 0) {
      this.ctx.log?.('warn', 'delivery.partial-failure', { errors, nonBlocking });
    }
    if (!ok && refs.length === 0) {
      const detail = errors.length > 0 ? errors.join('; ') : 'all sends returned null (no configured targets)';
      throw new Error(`Delivery failed to all targets: ${detail}`);
    }

    return { ok, refs };
  }

  async publish(text: string): Promise<DeliveryResult> {
    return this.send(text, { nonBlocking: true });
  }

  // ── Slack ──────────────────────────────────────────────────────────────

  private async sendSlack(
    text: string,
    parentRef: SlackRef | undefined,
    nonBlocking: boolean
  ): Promise<SlackRef | null> {
    const channel = slackChannel(this.ctx);
    if (!channel) return null;

    if (nonBlocking) {
      return this.sendSlackNonBlocking(channel, text, parentRef);
    }
    return this.sendSlackBlocking(channel, text, parentRef);
  }

  private async sendSlackBlocking(
    channel: string,
    text: string,
    parentRef?: SlackRef
  ): Promise<SlackRef | null> {
    const client = this.t.slackBlocking;
    if (!client) return null;

    const result = parentRef?.draftRef
      ? await client.post(channel, text, { replyTo: parentRef.draftRef })
      : await client.post(channel, text);

    if (!result.ts) {
      this.ctx.log?.('warn', 'delivery.slack.no-receipt', { channel });
      return null;
    }

    return {
      provider: 'slack',
      channel: result.channel,
      ts: result.ts,
      draftRef: result.ref
    };
  }

  /**
   * Non-blocking Slack: uses messages.write() directly with writebackTimeoutMs:0.
   * The parentRef is embedded in the message body so the cloud orders the message
   * under the parent server-side — zero receipt round-trips. The returned draftRef
   * is the relay path, usable as a parent for subsequent threaded sends.
   *
   * Mirrors the x-reply-radar parentRef threading pattern (internal-agents).
   */
  private async sendSlackNonBlocking(
    channel: string,
    text: string,
    parentRef?: SlackRef
  ): Promise<SlackRef | null> {
    const client = this.t.slackNonBlocking;
    if (!client) return null;

    const body: Record<string, unknown> = { text };
    if (parentRef?.draftRef) {
      // Embed parentRef in the body — the cloud lifts it from the streamed head
      // and orders this message under the parent once the parent delivers.
      body.parentRef = parentRef.draftRef;
    }

    const result = await client.messages.write({ channelId: channel }, body);

    return {
      provider: 'slack',
      channel,
      ts: '', // Not available yet (non-blocking)
      draftRef: result.path
    };
  }

  // ── Relaycast (agent-to-agent) ───────────────────────────────────────────

  private async sendRelaycast(text: string): Promise<RelaycastRef | null> {
    const rc = this.t.relaycast;
    if (!rc) return null;
    const res = await rc.sender.dm(rc.to, text);
    // Treat a missing message id as a failed delivery (matches slack/telegram,
    // which return null on a missing receipt) — don't report success with an
    // unusable ref.
    if (!res.ok || !res.messageId) {
      this.ctx.log?.('warn', 'delivery.relaycast.no-receipt', { to: rc.to });
      return null;
    }
    return { provider: 'relaycast', to: rc.to, messageId: res.messageId };
  }

  // ── Telegram ───────────────────────────────────────────────────────────

  private async sendTelegram(
    text: string,
    parentRef: TelegramRef | undefined,
    nonBlocking: boolean
  ): Promise<TelegramRef | null> {
    const chatId = telegramChat(this.ctx);
    if (!chatId) return null;

    const client = nonBlocking ? this.t.telegramNonBlocking : this.t.telegramBlocking;
    if (!client) return null;

    const result = parentRef?.messageId
      ? await client.sendMessage(chatId, text, { replyToMessageId: Number(parentRef.messageId) || undefined })
      : await client.sendMessage(chatId, text);

    if (!nonBlocking && !result.ok) {
      this.ctx.log?.('warn', 'delivery.telegram.no-receipt', { chatId });
      return null;
    }

    return {
      provider: 'telegram',
      chatId: result.chatId != null ? String(result.chatId) : chatId,
      messageId: result.ok ? result.messageId : ''
    };
  }
}
