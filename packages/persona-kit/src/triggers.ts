import type { PersonaSpec } from './types.js';

/**
 * Known event names per Relayfile provider, used by the deploy CLI to lint
 * a persona's declared triggers before deploy. The cloud runtime is the
 * authoritative source of truth — unknown names here produce a warning,
 * not a failure, so adding a new event upstream doesn't gate workforce
 * releases.
 *
 * This file ships intentionally sparse in v1 (see
 * `docs/plans/deploy-v1-codex-spec.md` Task 6). Codex fills it out from the
 * Relayfile adapter sources at `/Users/khaliqgant/Projects/AgentWorkforce/
 * relayfile-adapters/` plus the per-provider docs.
 */
export const KNOWN_TRIGGERS = {
  github: [
    'pull_request.opened',
    'pull_request.synchronize',
    'pull_request.closed',
    'pull_request_review_comment.created',
    'issue_comment.created',
    'issues.opened',
    'check_run.completed',
    'workflow_run.completed'
  ],
  linear: ['issue.created', 'issue.updated', 'comment.created'],
  slack: ['app_mention', 'message.channels'],
  notion: ['page.updated', 'page.created'],
  jira: ['issue.created', 'issue.updated', 'comment.created']
} as const satisfies Record<string, readonly string[]>;

export type KnownProviderName = keyof typeof KNOWN_TRIGGERS;
export type KnownTriggerName<P extends KnownProviderName> = (typeof KNOWN_TRIGGERS)[P][number];

export type TriggerLintLevel = 'warning';

export interface TriggerLintIssue {
  level: TriggerLintLevel;
  /** Provider slug the issue was raised under (`github`, `linear`, …). */
  provider: string;
  /** The trigger name that was flagged. */
  trigger: string;
  /** Field-pointed location, e.g. `integrations.github.triggers[2].on`. */
  path: string;
  message: string;
}

/**
 * Walk a persona's integration triggers and flag any that don't appear in
 * {@link KNOWN_TRIGGERS}. Always returns; never throws. Empty array when
 * the persona has no integrations or every trigger is recognized.
 *
 * The deploy CLI surfaces these as yellow warnings before deploy and
 * continues regardless. The runtime applies the trigger regardless of
 * what this registry knows.
 */
export function lintTriggers(persona: PersonaSpec): TriggerLintIssue[] {
  const issues: TriggerLintIssue[] = [];
  const integrations = persona.integrations;
  if (!integrations) return issues;

  for (const [provider, config] of Object.entries(integrations)) {
    const triggers = config.triggers;
    if (!triggers) continue;
    const known = (KNOWN_TRIGGERS as Record<string, readonly string[] | undefined>)[provider];

    if (!known) {
      // Unknown provider: warn once on the integration as a whole so we
      // don't spam per-trigger warnings for a provider workforce hasn't
      // catalogued yet.
      issues.push({
        level: 'warning',
        provider,
        trigger: '*',
        path: `integrations.${provider}`,
        message: `provider "${provider}" is not in the known-trigger registry; trigger names will not be linted`
      });
      continue;
    }

    for (const [idx, trigger] of triggers.entries()) {
      if (!known.includes(trigger.on)) {
        issues.push({
          level: 'warning',
          provider,
          trigger: trigger.on,
          path: `integrations.${provider}.triggers[${idx}].on`,
          message: `trigger "${trigger.on}" is not in the known-trigger registry for ${provider} (known: ${known.join(', ')})`
        });
      }
    }
  }

  return issues;
}
