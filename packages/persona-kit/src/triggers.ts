import type { PersonaSpec } from './types.js';

export const KNOWN_TRIGGERS = {
  github: [
    'pull_request.opened',
    'pull_request.synchronize',
    'pull_request.closed',
    'pull_request_review.submitted',
    'pull_request_review_comment.created',
    'push',
    'issues.opened',
    'issues.closed',
    'issue_comment.created',
    'check_run.completed',
    'workflow_run.completed'
  ] as const,
  linear: [
    'comment.create',
    'comment.update',
    'comment.remove',
    'cycle.create',
    'cycle.update',
    'cycle.remove',
    'issue.create',
    'issue.update',
    'issue.remove',
    'issue.created',
    'issue.updated',
    'issue.deleted',
    'milestone.create',
    'milestone.update',
    'milestone.remove',
    'project.create',
    'project.update',
    'project.remove',
    'roadmap.create',
    'roadmap.update',
    'roadmap.remove'
  ] as const,
  slack: [
    'app_mention',
    'app.mention',
    'app_rate_limited',
    'url_verification',
    'message.channels',
    'message.created',
    'message.updated',
    'message.deleted',
    'reaction.added',
    'reaction.removed',
    'channel.archived',
    'channel.created',
    'channel.member_joined',
    'channel.member_left',
    'channel.renamed',
    'channel.unarchived'
  ] as const,
  notion: [
    'page.created',
    'page.content_updated',
    'page.property_updated',
    'page.updated',
    'page.moved',
    'page.deleted',
    'database.created',
    'database.updated',
    'database.deleted',
    'block.created',
    'block.updated',
    'block.deleted',
    'comment.created',
    'comment.updated',
    'comment.deleted'
  ] as const,
  jira: [
    'comment.created',
    'comment.updated',
    'comment.deleted',
    'issue.created',
    'issue.updated',
    'issue.deleted',
    'project.created',
    'project.updated',
    'project.deleted',
    'sprint.created',
    'sprint.updated',
    'sprint.deleted'
  ] as const
} as const satisfies Record<string, readonly string[]>;

export type ProviderName = keyof typeof KNOWN_TRIGGERS;
export type TriggerOf<P extends ProviderName> = (typeof KNOWN_TRIGGERS)[P][number];

export interface TriggerLintIssue {
  level: 'warning';
  code: 'unknown_provider' | 'unknown_trigger';
  message: string;
  provider: string;
  trigger?: string;
  path: string;
}

export function isKnownProvider(provider: string): provider is ProviderName {
  return provider in KNOWN_TRIGGERS;
}

export function lintTriggers(persona: PersonaSpec): TriggerLintIssue[] {
  const issues: TriggerLintIssue[] = [];
  const integrations = persona.integrations ?? {};

  for (const [provider, config] of Object.entries(integrations)) {
    const providerPath = `integrations.${provider}`;
    if (!isKnownProvider(provider)) {
      issues.push({
        level: 'warning',
        code: 'unknown_provider',
        message: `Unknown integration provider "${provider}".`,
        provider,
        path: providerPath
      });
      continue;
    }

    const known = new Set<string>(KNOWN_TRIGGERS[provider]);
    for (const [index, trigger] of (config.triggers ?? []).entries()) {
      if (!known.has(trigger.on)) {
        issues.push({
          level: 'warning',
          code: 'unknown_trigger',
          message: `Unknown ${provider} trigger "${trigger.on}".`,
          provider,
          trigger: trigger.on,
          path: `${providerPath}.triggers[${index}].on`
        });
      }
    }
  }

  return issues;
}
