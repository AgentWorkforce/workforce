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

// v4: the envelope → event decoder lives in `to-agent-event.ts`
// (`envelopeToAgentEvent`), which produces the relay SDK's `AgentEvent`. The
// pre-v4 `shimEnvelope` (which produced the removed `WorkforceEvent` shape) is
// gone; this module now only owns the `RawGatewayEnvelope` wire contract.
