import { WorkforceIntegrationError } from '../errors.js';
import { providerRequest, type IntegrationClientOptions } from './request.js';

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

const linearEndpoint = '/graphql';

interface LinearResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

function unwrapLinear<T>(response: LinearResponse<T>, operation: string): T {
  if (!response.data || response.errors?.length) {
    throw new WorkforceIntegrationError({
      provider: 'linear',
      operation,
      cause: new Error(response.errors?.map((error) => error.message).join('; ') ?? 'Missing GraphQL data'),
      retryable: false
    });
  }
  return response.data;
}

export function createLinearClient(opts: IntegrationClientOptions): LinearClient {
  const graphql = async <T>(operation: string, query: string, variables: Record<string, unknown>) => {
    const response = await providerRequest<LinearResponse<T>>({
      provider: 'linear',
      operation,
      client: opts,
      endpoint: linearEndpoint,
      body: { query, variables }
    });
    return unwrapLinear(response, operation);
  };

  return {
    async createIssue(args) {
      const data = await graphql<{ issueCreate: { issue: { id: string; identifier: string; url: string } } }>(
        'createIssue',
        `mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) { issue { id identifier url } }
        }`,
        { input: args }
      );
      return data.issueCreate.issue;
    },

    async updateIssue(issueId, args) {
      const data = await graphql<{ issueUpdate: { issue: { id: string; identifier: string; url: string } } }>(
        'updateIssue',
        `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { issue { id identifier url } }
        }`,
        { id: issueId, input: args }
      );
      return data.issueUpdate.issue;
    },

    async comment(issueId, body) {
      const data = await graphql<{ commentCreate: { comment: { id: string; url: string } } }>(
        'comment',
        `mutation Comment($input: CommentCreateInput!) {
          commentCreate(input: $input) { comment { id url } }
        }`,
        { input: { issueId, body } }
      );
      return data.commentCreate.comment;
    },

    async getIssue(issueId) {
      const data = await graphql<{ issue: Awaited<ReturnType<LinearClient['getIssue']>> }>(
        'getIssue',
        `query Issue($id: String!) {
          issue(id: $id) { id identifier title description url state { name } }
        }`,
        { id: issueId }
      );
      return data.issue;
    }
  };
}
