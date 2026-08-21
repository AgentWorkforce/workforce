import type { AgentEvent } from './types.js';

export type MalformedAppTriggerReason =
  | 'missing-payload'
  | 'payload-not-object';

/**
 * A normalized manual/app-trigger wake-up.
 *
 * Cloud intentionally delivers app triggers as `cron.tick` events, so event
 * type alone cannot distinguish a scheduled run from a caller-supplied JSON
 * body. This union preserves that distinction and keeps malformed accepted
 * requests visible to the agent instead of silently treating them as clock
 * ticks.
 */
export type AppTriggerIntent =
  | { kind: 'not-app-trigger' }
  | { kind: 'app-trigger'; payload: Record<string, unknown> }
  | {
      kind: 'malformed-app-trigger';
      reason: MalformedAppTriggerReason;
      payload?: unknown;
    };

/**
 * Read Cloud's authenticated app-trigger wrapper from a normalized event.
 *
 * Current v4 events expose the original envelope through
 * `event.expand('full').data`. One nested `resource` wrapper is also accepted
 * for compatibility with older gateway fixtures. Bare objects are never
 * treated as app triggers: the explicit `source: "app.trigger"` marker is
 * required, which prevents ordinary provider payloads and scheduled ticks
 * from being misclassified.
 *
 * A scheduled tick has no full expansion, so expansion rejection means
 * `not-app-trigger`. Once the marker is present, however, an absent or
 * non-object payload is reported as malformed rather than downgraded to a
 * schedule firing.
 */
export async function readAppTriggerIntent(
  event: Pick<AgentEvent, 'expand'>
): Promise<AppTriggerIntent> {
  let data: unknown;
  try {
    data = (await event.expand('full')).data;
  } catch {
    return { kind: 'not-app-trigger' };
  }

  const wrapper = appTriggerWrapper(data);
  if (!wrapper) return { kind: 'not-app-trigger' };
  if (!Object.prototype.hasOwnProperty.call(wrapper, 'payload')) {
    return { kind: 'malformed-app-trigger', reason: 'missing-payload' };
  }

  const payload = wrapper.payload;
  if (!isRecord(payload)) {
    return {
      kind: 'malformed-app-trigger',
      reason: 'payload-not-object',
      payload
    };
  }
  return { kind: 'app-trigger', payload };
}

function appTriggerWrapper(value: unknown): Record<string, unknown> | null {
  const outer = isRecord(value) ? value : null;
  if (!outer) return null;
  if (outer.source === 'app.trigger') return outer;
  const nested = isRecord(outer.resource) ? outer.resource : null;
  return nested?.source === 'app.trigger' ? nested : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
