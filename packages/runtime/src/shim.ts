import type {
  WorkforceCronEvent,
  WorkforceEvent,
  WorkforceEventSource,
  WorkforceProviderEvent
} from './types.js';

/**
 * Raw envelope shape the cloud proactive-runtime gateway delivers per M1
 * spec (`cloud-proactive-runtime-spec/docs/proactive-runtime/spec.md`).
 *
 * This is workforce's own type, not an import from `@agent-relay/agent` —
 * and intentionally so. The relay agent SDK exports *decoded* events
 * (`CronTickEvent`, `RelayfileChangeEvent`, …) but no raw-envelope type;
 * the wire format below is cloud's gateway contract, mirrored here and
 * pinned to `envelope-fields.cloud.ts` (cloud#1841) via
 * `shim.contract.test.ts`. There is nothing in the SDK to "swap to" — the
 * runtime owns this decode boundary so it can track the cloud gateway
 * contract independently of the SDK's version.
 */
export interface RawGatewayEnvelope {
  id: string;
  workspace: string;
  /** Dotted type like `cron.tick`, `github.pull_request.opened`. */
  type: string;
  occurredAt: string;
  attempt?: number;
  resource?: unknown;
  summary?: Record<string, unknown>;
  expand?: unknown;
  digest?: string;
  /** Cron-only: the schedule name. */
  name?: string;
  /** Cron-only: the schedule's cron expression. */
  cron?: string;
  /** Provider id cloud derived for the event (e.g. "github"). */
  provider?: string;
  /** Provider-qualified event name as cloud received it. */
  eventType?: string;
  /** Upstream webhook delivery id, when the provider supplied one. */
  deliveryId?: string;
  /** Relayfile paths the event touched (drives event-scoped mount sync). */
  paths?: string[];
  /** Opaque resume token for multi-phase deliveries (pr-reviewer resume). */
  resumeContext?: unknown;
  /** Harness resume session cloud attaches for multi-phase deliveries. */
  harnessSession?: unknown;
  /** Relaycast channel (or DM id) for `relaycast.message` envelopes. */
  channel?: string;
  /** Relaycast message id for `relaycast.message` envelopes. */
  messageId?: string;
  /** Relaycast thread id for `relaycast.message` envelopes, when threaded. */
  threadId?: string;
}

/**
 * Every field cloud's `buildEnvelope` can emit on a delivered envelope.
 * MUST stay in lockstep with the checked-in contract copy in
 * `envelope-fields.cloud.ts` (source: cloud
 * `packages/web/lib/proactive-runtime/deployment-trigger-delivery.ts`
 * `ENVELOPE_FIELDS`, cloud#1841) — `shim.contract.test.ts` fails on drift,
 * and a `satisfies` check below fails compilation if a listed field is not
 * actually declared on `RawGatewayEnvelope`.
 */
export const RAW_GATEWAY_ENVELOPE_FIELDS = [
  'id',
  'workspace',
  'type',
  'occurredAt',
  'attempt',
  'name',
  'cron',
  'resource',
  'provider',
  'eventType',
  'deliveryId',
  'paths',
  'summary',
  'resumeContext',
  'harnessSession',
  'channel',
  'messageId',
  'threadId',
  // Declared on the frame but never emitted by cloud's buildEnvelope —
  // kept for older gateway shapes; not part of the cloud contract.
  'expand',
  'digest',
] as const satisfies readonly (keyof RawGatewayEnvelope)[];

type ProviderSource = Exclude<WorkforceEventSource, 'cron'>;

const PROVIDER_SOURCES: ReadonlySet<ProviderSource> = new Set<ProviderSource>([
  'github',
  'linear',
  'slack',
  'notion',
  'jira'
]);

function isProviderSource(value: string): value is ProviderSource {
  return PROVIDER_SOURCES.has(value as ProviderSource);
}

/**
 * Translate a raw gateway envelope into a discriminated WorkforceEvent.
 *
 * Returns `null` for envelope shapes the v1 runtime does not yet know how
 * to dispatch — the caller logs and acks (we don't want to crash-loop the
 * runner on an envelope from a newer gateway).
 */
export function shimEnvelope(env: RawGatewayEnvelope): WorkforceEvent | null {
  if (typeof env.id !== 'string' || !env.id) return null;
  if (typeof env.workspace !== 'string' || !env.workspace) return null;
  if (typeof env.type !== 'string' || !env.type) return null;

  const attempt = typeof env.attempt === 'number' && env.attempt > 0 ? env.attempt : 1;
  const occurredAt = typeof env.occurredAt === 'string' ? env.occurredAt : new Date().toISOString();

  if (env.type === 'cron.tick' || env.type.startsWith('cron.')) {
    const cron: WorkforceCronEvent = {
      source: 'cron',
      id: env.id,
      occurredAt,
      attempt,
      workspaceId: env.workspace,
      name: typeof env.name === 'string' ? env.name : extractCronName(env.type),
      cron: typeof env.cron === 'string' ? env.cron : ''
    };
    return cron;
  }

  // Provider envelopes are typed as `<provider>.<event.name>` — e.g.
  // `github.pull_request.opened`. Split once on the first dot.
  const firstDot = env.type.indexOf('.');
  if (firstDot <= 0) return null;
  const providerCandidate = env.type.slice(0, firstDot);
  if (!isProviderSource(providerCandidate)) return null;
  const eventType = env.type.slice(firstDot + 1);
  // Guard against envelopes like `github.` where the source is valid but
  // the event-name suffix is missing. The runtime should not dispatch an
  // empty `event.type` to handlers — better to drop the envelope and let
  // it surface in the unsupported-envelope log.
  if (!eventType) return null;

  const providerEvent: WorkforceProviderEvent = {
    source: providerCandidate,
    id: env.id,
    occurredAt,
    attempt,
    workspaceId: env.workspace,
    type: eventType,
    payload: env.resource ?? null,
    ...(env.summary ? { summary: env.summary } : {})
  };
  return providerEvent;
}

function extractCronName(typeStr: string): string {
  // Accepts both `cron.tick` (no name) and `cron.tick:<name>` form
  // observed in some adapter outputs.
  const colon = typeStr.indexOf(':');
  return colon > 0 ? typeStr.slice(colon + 1) : '';
}
