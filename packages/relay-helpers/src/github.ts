import type { IntegrationClientOptions } from '@agentworkforce/runtime/clients';
import { relayClient } from './generic.js';
import { created } from './receipt.js';

export interface GithubTarget {
  owner: string;
  repo: string;
  number: number;
}

export interface GithubClient {
  /** Comment on an issue or pull request. */
  comment(target: GithubTarget, body: string): Promise<{ id: string; url: string }>;
  /** Create an issue. */
  createIssue(args: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels?: string[];
  }): Promise<{ id: string; url: string }>;
  /** Merge a pull request. */
  merge(args: {
    owner: string;
    repo: string;
    number: number;
    method?: 'merge' | 'squash' | 'rebase';
    commitTitle?: string;
    commitMessage?: string;
    sha?: string;
  }): Promise<{ merged: boolean; sha?: string }>;
  /** Post a review on a pull request. */
  review(
    target: GithubTarget,
    args: {
      body: string;
      event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
      comments?: Array<{ path: string; line: number; body: string }>;
    }
  ): Promise<void>;
}

/**
 * Ergonomic GitHub client over the writeback-path catalog. Recovers the
 * `ctx.github.comment(...)` shape removed from the runtime.
 */
export function githubClient(opts: IntegrationClientOptions = {}): GithubClient {
  const relay = relayClient('github', opts);
  return {
    async comment(target, body) {
      return created(
        await relay.write(
          'issue-comments',
          { owner: target.owner, repo: target.repo, issueNumber: target.number },
          { body }
        )
      );
    },
    async createIssue(args) {
      return created(
        await relay.write(
          'issues',
          { owner: args.owner, repo: args.repo },
          { title: args.title, body: args.body, ...(args.labels ? { labels: args.labels } : {}) }
        )
      );
    },
    async merge(args) {
      const result = await relay.write(
        'merge',
        { owner: args.owner, repo: args.repo, pullNumber: args.number },
        {
          ...(args.method !== undefined ? { merge_method: args.method } : {}),
          ...(args.commitTitle !== undefined ? { commit_title: args.commitTitle } : {}),
          ...(args.commitMessage !== undefined ? { commit_message: args.commitMessage } : {}),
          ...(args.sha !== undefined ? { sha: args.sha } : {})
        }
      );
      const sha =
        typeof result.receipt?.sha === 'string'
          ? result.receipt.sha
          : typeof result.receipt?.id === 'string'
            ? result.receipt.id
            : undefined;
      const merged = result.receipt?.merged;
      return {
        merged: merged === true || merged === 'true' || (merged === undefined && Boolean(sha)),
        ...(sha ? { sha } : {})
      };
    },
    async review(target, args) {
      await relay.write(
        'reviews',
        { owner: target.owner, repo: target.repo, pullNumber: target.number },
        { ...args, comments: args.comments ?? [] }
      );
    }
  };
}
