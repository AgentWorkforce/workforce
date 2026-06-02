import type { IntegrationClientOptions } from '@agentworkforce/runtime/clients';
import { providerClient, type ProviderClient } from './provider-client.js';
import { created } from './receipt.js';

export interface GithubTarget {
  owner: string;
  repo: string;
  number: number;
}

export interface GithubClient extends ProviderClient<'github'> {
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
  /**
   * Merge a pull request. (Named `mergePullRequest`, not `merge`, because
   * `merge` is the catalog resource key exposed as `.merge`.)
   */
  mergePullRequest(args: {
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
 * Ergonomic GitHub client over the writeback-path catalog, plus the uniform
 * resource-keyed access (`.issues`, `.["issue-comments"]`, `.merge`, `.reviews`).
 */
export function githubClient(opts: IntegrationClientOptions = {}): GithubClient {
  const base = providerClient('github', opts);
  return Object.assign(base, {
    async comment(target: GithubTarget, body: string) {
      return created(
        await base['issue-comments'].write(
          { owner: target.owner, repo: target.repo, issueNumber: target.number },
          { body }
        )
      );
    },
    async createIssue(args: { owner: string; repo: string; title: string; body: string; labels?: string[] }) {
      return created(
        await base.issues.write(
          { owner: args.owner, repo: args.repo },
          { title: args.title, body: args.body, ...(args.labels ? { labels: args.labels } : {}) }
        )
      );
    },
    async mergePullRequest(args: {
      owner: string;
      repo: string;
      number: number;
      method?: 'merge' | 'squash' | 'rebase';
      commitTitle?: string;
      commitMessage?: string;
      sha?: string;
    }) {
      const result = await base.merge.write(
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
    async review(
      target: GithubTarget,
      args: {
        body: string;
        event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
        comments?: Array<{ path: string; line: number; body: string }>;
      }
    ) {
      await base.reviews.write(
        { owner: target.owner, repo: target.repo, pullNumber: target.number },
        { ...args, comments: args.comments ?? [] }
      );
    }
  }) as GithubClient;
}
