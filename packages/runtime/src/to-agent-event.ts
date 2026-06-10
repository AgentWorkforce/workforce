import {
  createAgentEvent,
  createCronTickEvent,
  createStartupEvent,
  type AgentEvent,
  type EventResource,
  type EventSummary,
  type EventType
} from '@agent-relay/events';
import type { RawGatewayEnvelope } from './shim.js';

/**
 * Map a cloud proactive-runtime gateway envelope ({@link RawGatewayEnvelope})
 * into the relay SDK's normalized {@link AgentEvent}.
 *
 * This is the kernel of the runtime's planned migration onto `@agent-relay/
 * events` (see `raw.ts`/`shim.ts`): it proves the gateway wire contract can be
 * expressed in the published SDK's event model using only published
 * constructors — no upstream change required. It is intentionally **additive**
 * — `shimEnvelope()` (which produces the legacy `WorkforceEvent` consumed by
 * persona handlers today) is unchanged. Switching the dispatch path and the
 * public handler signature over to `AgentEvent` is a separate, breaking stage.
 *
 * Returns `null` for envelope shapes the mapper can't normalize, mirroring
 * `shimEnvelope`'s drop-and-ack behavior so a newer gateway can't crash-loop
 * the runner.
 *
 * Fidelity note: cloud delivers the provider payload in `env.resource`, while
 * the SDK exposes payloads through `expand('full')`. We wire a `loadFull`
 * loader so handlers can still reach the payload, but the richer summary/diff/
 * thread expansions the SDK models are only as detailed as cloud's envelope —
 * closing that gap is a cloud-gateway enrichment, not an SDK change.
 */
export function envelopeToAgentEvent(env: RawGatewayEnvelope): AgentEvent | null {
  if (typeof env.id !== 'string' || !env.id) return null;
  if (typeof env.workspace !== 'string' || !env.workspace) return null;
  if (typeof env.type !== 'string' || !env.type) return null;

  const attempt = typeof env.attempt === 'number' && env.attempt > 0 ? env.attempt : 1;
  const occurredAt = typeof env.occurredAt === 'string' ? env.occurredAt : undefined;
  const digest = typeof env.digest === 'string' ? env.digest : undefined;
  const summary = isPlainObject(env.summary) ? (env.summary as EventSummary) : undefined;

  if (env.type === 'cron.tick' || env.type.startsWith('cron.')) {
    return createCronTickEvent({
      workspace: env.workspace,
      // The SDK's cron event carries the expression as `schedule`; the human
      // schedule name (cloud's `env.name`) becomes the synthetic resource id.
      schedule: typeof env.cron === 'string' && env.cron ? env.cron : (env.name ?? ''),
      scheduleId: typeof env.name === 'string' && env.name ? env.name : undefined,
      id: env.id,
      attempt,
      occurredAt,
      digest,
      summary
    });
  }

  if (env.type === 'startup') {
    return createStartupEvent({
      workspace: env.workspace,
      id: env.id,
      attempt,
      occurredAt,
      digest,
      summary
    });
  }

  // Relaycast inbox messages. Two cloud delivery shapes converge here:
  //   - `relaycast.message` — a fresh inbox trigger. The relay-native gateway
  //     (`agent-gateway/envelope-builder.ts`) emits `channel`/`messageId`/
  //     `threadId` as top-level fields, but the proactive-runtime HTTP gateway
  //     (`deployment-trigger-delivery.ts`, which `RawGatewayEnvelope` mirrors)
  //     does not carry them in `ENVELOPE_FIELDS` yet — they ride inside
  //     `resource` (`resource: payload.resource ?? payload`). We read from
  //     `resource` so this works today; promoting them to first-class envelope
  //     fields is the cross-repo follow-up the cloud contract test anticipates.
  //   - `user_reply` — cloud's continuation resume when a human answers a
  //     thread the agent paused on. Semantically a relaycast message; the
  //     thread id rides in `resumeContext`.
  if (env.type === 'relaycast.message' || env.type === 'user_reply') {
    const res = isPlainObject(env.resource) ? env.resource : {};
    const message = isPlainObject(res.message) ? res.message : undefined;
    const resume = isPlainObject(env.resumeContext) ? env.resumeContext : {};
    // Prefer the first-class envelope fields (cloud now surfaces these top-level
    // per Unit B / workforce#189); fall back to `resource` for envelopes from an
    // older gateway that still nests them, then to the message/resume shapes.
    const channel = firstString(env.channel) ?? firstString(res.channel) ?? 'dm';
    const messageId =
      firstString(env.messageId) ??
      firstString(res.messageId) ??
      firstString(message?.id) ??
      (typeof env.deliveryId === 'string' && env.deliveryId ? env.deliveryId : env.id);
    const threadId =
      firstString(env.threadId) ?? firstString(res.threadId) ?? firstString(resume.threadId);
    const text = firstString(res.text) ?? firstString(message?.text);
    const path = firstString(res.path) ?? `/relaycast/${channel}/messages/${messageId}`;
    return createAgentEvent(
      {
        workspace: env.workspace,
        type: 'relaycast.message',
        id: env.id,
        attempt,
        occurredAt,
        resource: { path, kind: 'relaycast.message', id: messageId, provider: 'relaycast' },
        summary: summary ?? (text ? { title: text.slice(0, 120) } : undefined),
        digest,
        channel,
        messageId,
        ...(threadId ? { threadId } : {})
      },
      isPlainObject(env.resource)
        ? { loadFull: async () => ({ level: 'full' as const, path, data: env.resource as Record<string, unknown>, digest }) }
        : undefined
    );
  }

  // Provider envelopes are typed `<provider>.<event.name>` — e.g.
  // `github.pull_request.opened`, `linear.issue.created`.
  const firstDot = env.type.indexOf('.');
  if (firstDot <= 0) return null;
  const suffix = env.type.slice(firstDot + 1);
  if (!suffix) return null;
  const provider =
    typeof env.provider === 'string' && env.provider ? env.provider : env.type.slice(0, firstDot);

  const path = Array.isArray(env.paths) && typeof env.paths[0] === 'string' ? env.paths[0] : '';
  const resource: EventResource = {
    path,
    // `kind` is the provider-scoped object type, dropping the trailing action:
    // `github.pull_request.opened` -> `github.pull_request`.
    kind: deriveKind(env.type),
    id: typeof env.deliveryId === 'string' && env.deliveryId ? env.deliveryId : env.id,
    provider
  };

  // Cloud delivers the provider payload in `env.resource`. The SDK's
  // `expand('full')` returns a `FullExpansion` whose `data` is a record, so we
  // only wire the loader when the payload is an object (the normal case); other
  // shapes fall back to the SDK's default expander.
  const payload = env.resource;
  return createAgentEvent(
    {
      workspace: env.workspace,
      type: env.type as EventType,
      id: env.id,
      attempt,
      occurredAt,
      resource,
      summary,
      digest
    },
    isPlainObject(payload)
      ? { loadFull: async () => ({ level: 'full' as const, path, data: payload, digest }) }
      : undefined
  );
}

/**
 * Drop the trailing action segment from a provider event type to recover the
 * resource kind: `github.pull_request.opened` -> `github.pull_request`. Types
 * with only `<provider>.<name>` (no action) are returned unchanged.
 */
function deriveKind(type: string): string {
  const lastDot = type.lastIndexOf('.');
  const firstDot = type.indexOf('.');
  return lastDot > firstDot ? type.slice(0, lastDot) : type;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Return `value` when it is a non-empty string, else `undefined`. */
function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
