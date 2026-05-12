import { providerRequest, type IntegrationClientOptions } from './request.js';

export interface JiraClient {
  createIssue(args: {
    cloudId: string;
    fields: Record<string, unknown>;
  }): Promise<{ id: string; key: string; self: string }>;
  comment(
    target: { cloudId: string; issueIdOrKey: string },
    body: string | Record<string, unknown>
  ): Promise<{ id: string; self: string }>;
  transition(
    target: { cloudId: string; issueIdOrKey: string },
    transition: string | { id: string }
  ): Promise<void>;
}

function jiraApi(cloudId: string): string {
  return `/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3`;
}

export function createJiraClient(opts: IntegrationClientOptions): JiraClient {
  const request = <T>(operation: string, cloudId: string, path: string, init: {
    method?: string;
    body?: unknown;
    parseAs?: 'json' | 'void';
  } = {}) => providerRequest<T>({
    provider: 'jira',
    operation,
    client: opts,
    endpoint: `${jiraApi(cloudId)}/${path}`,
    ...init
  });

  return {
    createIssue(args) {
      return request<{ id: string; key: string; self: string }>('createIssue', args.cloudId, 'issue', {
        body: { fields: args.fields }
      });
    },

    comment(target, body) {
      return request<{ id: string; self: string }>(
        'comment',
        target.cloudId,
        `issue/${encodeURIComponent(target.issueIdOrKey)}/comment`,
        { body: { body } }
      );
    },

    async transition(target, transition) {
      const id = typeof transition === 'string' ? transition : transition.id;
      await request<void>(
        'transition',
        target.cloudId,
        `issue/${encodeURIComponent(target.issueIdOrKey)}/transitions`,
        { body: { transition: { id } }, parseAs: 'void' }
      );
    }
  };
}
