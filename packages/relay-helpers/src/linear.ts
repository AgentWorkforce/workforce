import {
  readJsonFile,
  writeJsonFile,
  type IntegrationClientOptions
} from '@agentworkforce/runtime/clients';
import { encodeSegment, relayClient } from './generic.js';
import { created } from './receipt.js';

export interface LinearClient {
  /** Comment on an issue. */
  comment(issueId: string, body: string): Promise<{ id: string; url: string }>;
  /** Create an issue. */
  createIssue(args: {
    teamId: string;
    title: string;
    description?: string;
    assigneeId?: string;
    labelIds?: string[];
    projectId?: string;
    stateId?: string;
  }): Promise<{ id: string; url: string }>;
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
 * `ctx.linear.comment(...)` shape removed from the runtime, with paths sourced
 * from `@relayfile/adapter-core` rather than hardcoded.
 */
export function linearClient(opts: IntegrationClientOptions = {}): LinearClient {
  const relay = relayClient('linear', opts);
  const issuePath = (issueId: string) => `${relay.path('issues')}/${encodeSegment(issueId)}.json`;
  return {
    async comment(issueId, body) {
      return created(await relay.write('comments', { issueId }, { body }));
    },
    async createIssue(args) {
      const result = await relay.write('issues', {}, args);
      const id = result.receipt?.created ?? result.receipt?.id ?? result.path;
      return {
        id,
        url: result.receipt?.url ?? result.path
      };
    },
    async updateIssue(issueId, args) {
      await writeJsonFile(opts, 'linear', 'updateIssue', issuePath(issueId), args);
    },
    getIssue<T = Record<string, unknown>>(issueId: string): Promise<T> {
      return readJsonFile<T>(opts, 'linear', 'getIssue', issuePath(issueId));
    },
    listIssues<T = Record<string, unknown>>(): Promise<T[]> {
      return relay.list<T>('issues');
    }
  };
}
