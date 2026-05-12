import {
  draftFile,
  encodeSegment,
  type IntegrationClientOptions,
  readJsonFile,
  writeJsonFile
} from './request.js';

export interface LinearClient {
  createIssue(args: {
    teamId: string;
    title: string;
    description?: string;
    assigneeId?: string;
    labelIds?: string[];
    projectId?: string;
    stateId?: string;
  }): Promise<{ id: string; identifier: string; url: string }>;
  updateIssue(
    issueId: string,
    args: { title?: string; description?: string; assigneeId?: string; stateId?: string }
  ): Promise<{ id: string; identifier: string; url: string }>;
  comment(issueId: string, body: string): Promise<{ id: string; url: string }>;
  getIssue(issueId: string): Promise<{
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    url: string;
    state: { name: string } | null;
  }>;
}

type LinearIssue = Awaited<ReturnType<LinearClient['getIssue']>>;

export function createLinearClient(opts: IntegrationClientOptions): LinearClient {
  return {
    async createIssue(args) {
      const result = await writeJsonFile(
        opts,
        'linear',
        'createIssue',
        `/linear/issues/${draftFile('create issue')}`,
        args
      );
      return {
        id: result.receipt?.created ?? result.receipt?.id ?? '',
        identifier: typeof result.receipt?.identifier === 'string' ? result.receipt.identifier : '',
        url: result.receipt?.url ?? ''
      };
    },

    async updateIssue(issueId, args) {
      await writeJsonFile(opts, 'linear', 'updateIssue', `/linear/issues/${encodeSegment(issueId)}.json`, args);
      const issue = await this.getIssue(issueId).catch(() => undefined);
      return {
        id: issue?.id ?? issueId,
        identifier: issue?.identifier ?? '',
        url: issue?.url ?? ''
      };
    },

    async comment(issueId, body) {
      const result = await writeJsonFile(
        opts,
        'linear',
        'comment',
        `/linear/issues/${encodeSegment(issueId)}/comments/${draftFile('create comment')}`,
        { body }
      );
      return { id: result.receipt?.created ?? result.receipt?.id ?? '', url: result.receipt?.url ?? '' };
    },

    getIssue(issueId) {
      return readJsonFile<LinearIssue>(opts, 'linear', 'getIssue', `/linear/issues/${encodeSegment(issueId)}.json`);
    }
  };
}
