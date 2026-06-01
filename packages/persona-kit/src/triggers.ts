import type { AgentSpec } from './types.js';
import { KNOWN_TRIGGER_CATALOG } from '@relayfile/adapter-core/triggers';

/**
 * Known event names per Relayfile provider, used by the deploy CLI to lint
 * a persona's declared triggers before deploy. The cloud runtime is the
 * authoritative source of truth — unknown names here produce a warning,
 * not a failure, so adding a new event upstream doesn't gate workforce
 * releases.
 */
export const KNOWN_TRIGGER_PROVIDER_ALIASES = {
  'google-mail': 'gmail'
} as const satisfies Record<string, keyof typeof KNOWN_TRIGGER_CATALOG>;

const KNOWN_TRIGGER_ALIAS_CATALOG = Object.fromEntries(
  Object.entries(KNOWN_TRIGGER_PROVIDER_ALIASES).map(([alias, canonical]) => [
    alias,
    KNOWN_TRIGGER_CATALOG[canonical]
  ])
) as {
  [Provider in keyof typeof KNOWN_TRIGGER_PROVIDER_ALIASES]:
    (typeof KNOWN_TRIGGER_CATALOG)[(typeof KNOWN_TRIGGER_PROVIDER_ALIASES)[Provider]];
};

export const KNOWN_TRIGGERS = {
  ...KNOWN_TRIGGER_CATALOG,
  ...KNOWN_TRIGGER_ALIAS_CATALOG
};

export {
  ADAPTERS_WITHOUT_KNOWN_TRIGGERS,
  KNOWN_TRIGGER_CATALOG,
  type KnownProviderName,
  type KnownTriggerName
} from '@relayfile/adapter-core/triggers';

export type TriggerLintLevel = 'warning';

/**
 * Machine-readable issue category, so callers can branch on
 * `issue.code` without parsing the human-readable `message`.
 */
export type TriggerLintCode =
  | 'unknown_provider'
  | 'unknown_trigger'
  | 'watch_path_not_absolute'
  | 'watch_empty_events';

export interface TriggerLintIssue {
  level: TriggerLintLevel;
  code: TriggerLintCode;
  /** Provider slug the issue was raised under (`github`, `linear`, …). */
  provider: string;
  /** The trigger name that was flagged. */
  trigger: string;
  /** Field-pointed location, e.g. `triggers.github[2].on`. */
  path: string;
  message: string;
}

/**
 * Walk an agent's triggers and flag any that don't appear in
 * {@link KNOWN_TRIGGERS}. Always returns; never throws. Empty array when
 * the agent has no triggers or every trigger is recognized.
 *
 * The deploy CLI surfaces these as yellow warnings before deploy and
 * continues regardless. The runtime applies the trigger regardless of
 * what this registry knows.
 */
export function lintTriggers(agent: AgentSpec): TriggerLintIssue[] {
  const issues: TriggerLintIssue[] = [];
  const triggers = agent.triggers;

  if (triggers) {
    for (const [provider, providerTriggers] of Object.entries(triggers)) {
      if (!providerTriggers) continue;
      const known = knownTriggersForProvider(provider);

      if (!known) {
        // Unknown provider: warn once on the provider as a whole so we don't
        // spam per-trigger warnings for a provider workforce hasn't
        // catalogued yet.
        issues.push({
          level: 'warning',
          code: 'unknown_provider',
          provider,
          trigger: '*',
          path: `triggers.${provider}`,
          message: `provider "${provider}" is not in the known-trigger registry; trigger names will not be linted`
        });
        continue;
      }

      for (const [idx, trigger] of providerTriggers.entries()) {
        if (!known.includes(trigger.on)) {
          issues.push({
            level: 'warning',
            code: 'unknown_trigger',
            provider,
            trigger: trigger.on,
            path: `triggers.${provider}[${idx}].on`,
            message: `trigger "${trigger.on}" is not in the known-trigger registry for ${provider} (known: ${known.join(', ')})`
          });
        }
      }
    }
  }

  for (const [idx, rule] of (agent.watch ?? []).entries()) {
    if (!rule.events || rule.events.length === 0) {
      issues.push({
        level: 'warning',
        code: 'watch_empty_events',
        provider: 'relayfile',
        trigger: '*',
        path: `watch[${idx}].events`,
        message: 'watch rule must declare at least one relayfile event'
      });
    }
    for (const [pathIdx, path] of (rule.paths ?? []).entries()) {
      if (!path.startsWith('/')) {
        issues.push({
          level: 'warning',
          code: 'watch_path_not_absolute',
          provider: 'relayfile',
          trigger: '*',
          path: `watch[${idx}].paths[${pathIdx}]`,
          message: `watch path "${path}" must start with /`
        });
      }
    }
  }

  return issues;
}

function knownTriggersForProvider(provider: string): readonly string[] | undefined {
  return (KNOWN_TRIGGERS as Record<string, readonly string[] | undefined>)[provider];
}
