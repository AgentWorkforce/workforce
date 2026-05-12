import type {
  WorkforceCronEvent,
  WorkforceEvent,
  WorkforceEventSource,
  WorkforceProviderEvent
} from './types.js';

/**
 * Raw envelope shape the cloud proactive-runtime gateway delivers per M1
 * spec (`cloud-proactive-runtime-spec/docs/proactive-runtime/spec.md`).
 * Kept as a structural type rather than imported from `@agent-relay/agent`
 * so the runtime compiles even when that package isn't yet published.
 *
 * Once `@agent-relay/agent` ships, the shim swaps its internal envelope
 * type for the SDK's published one — call sites stay unchanged.
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
}

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

  const providerEvent: WorkforceProviderEvent = {
    source: providerCandidate,
    id: env.id,
    occurredAt,
    attempt,
    workspaceId: env.workspace,
    type: env.type.slice(firstDot + 1),
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
