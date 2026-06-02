import {
  readJsonFile,
  writeJsonFile,
  type IntegrationClientOptions
} from '@agentworkforce/runtime/clients';
import { encodeSegment } from './generic.js';
import { providerClient, type ProviderClient } from './provider-client.js';
import { created } from './receipt.js';

export interface LinearCreateIssueArgs {
  teamId: string;
  title: string;
  description?: string;
  assigneeId?: string;
  labelIds?: string[];
  projectId?: string;
  stateId?: string;
}

export interface LinearClient extends ProviderClient<'linear'> {
  /** Comment on an issue. */
  comment(issueId: string, body: string): Promise<{ id: string; url: string }>;
  /** Create an issue. */
  createIssue(args: LinearCreateIssueArgs): Promise<{ id: string; url: string }>;
  /** Patch an existing issue. */
  updateIssue(
    issueId: string,
    args: { title?: string; description?: string; assigneeId?: string; stateId?: string }
  ): Promise<void>;
  /** Read one issue by id. */
  getIssue<T = Record<string, unknown>>(issueId: string): Promise<T>;
  /** List issues. */
  listIssues<T = Record<string, unknown>>(): Promise<T[]>;
}

/**
 * Ergonomic Linear client over the writeback-path catalog. Recovers the
 * `ctx.linear.comment(...)` shape removed from the runtime, plus the uniform
 * resource-keyed access (`.issues`, `.comments`) every provider client has.
 */
export function linearClient(opts: IntegrationClientOptions = {}): LinearClient {
  const base = providerClient('linear', opts);
  const issuePath = (issueId: string) => `${base.issues.path()}/${encodeSegment(issueId)}.json`;
  return Object.assign(base, {
    async comment(issueId: string, body: string) {
      return created(await base.comments.write({ issueId }, { body }));
    },
    async createIssue(args: LinearCreateIssueArgs) {
      return created(await base.issues.write({}, args));
    },
    async updateIssue(issueId: string, args: Record<string, unknown>) {
      await writeJsonFile(opts, 'linear', 'updateIssue', issuePath(issueId), args);
    },
    getIssue<T = Record<string, unknown>>(issueId: string): Promise<T> {
      return readJsonFile<T>(opts, 'linear', 'getIssue', issuePath(issueId));
    },
    listIssues<T = Record<string, unknown>>(): Promise<T[]> {
      return base.issues.list<T>();
    }
  }) as LinearClient;
}
