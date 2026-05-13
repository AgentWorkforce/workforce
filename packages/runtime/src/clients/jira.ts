import { WorkforceIntegrationError } from '../errors.js';
import {
  draftFile,
  encodeSegment,
  type IntegrationClientOptions,
  writeJsonFile
} from './request.js';

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

export function createJiraClient(opts: IntegrationClientOptions): JiraClient {
  return {
    async createIssue(args) {
      const result = await writeJsonFile(
        opts,
        'jira',
        'createIssue',
        `/jira/issues/${draftFile('create issue')}`,
        { cloudId: args.cloudId, fields: args.fields }
      );
      return {
        id: result.receipt?.created ?? result.receipt?.id ?? result.path,
        key: typeof result.receipt?.key === 'string' ? result.receipt.key : '',
        self: typeof result.receipt?.self === 'string' ? result.receipt.self : result.path
      };
    },

    async comment(target, body) {
      const result = await writeJsonFile(
        opts,
        'jira',
        'comment',
        `/jira/issues/${encodeSegment(target.issueIdOrKey)}/comments/${draftFile('create comment')}`,
        { cloudId: target.cloudId, body }
      );
      return {
        id: result.receipt?.created ?? result.receipt?.id ?? result.path,
        self: typeof result.receipt?.self === 'string' ? result.receipt.self : result.path
      };
    },

    async transition(target, transition) {
      const id = typeof transition === 'string' ? transition.trim() : transition.id.trim();
      if (id.length === 0) {
        throw new WorkforceIntegrationError({
          provider: 'jira',
          operation: 'transition',
          cause: new Error('Jira transition id must be a non-empty string'),
          retryable: false
        });
      }
      await writeJsonFile(
        opts,
        'jira',
        'transition',
        `/jira/issues/${encodeSegment(target.issueIdOrKey)}/transitions/${draftFile('create transition')}`,
        { cloudId: target.cloudId, transition: { id } }
      );
    }
  };
}
