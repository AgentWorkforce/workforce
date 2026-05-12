import { providerRequest, type IntegrationClientOptions } from './request.js';

export interface GithubClient {
  comment(
    target: { owner: string; repo: string; number: number },
    body: string
  ): Promise<{ id: string; url: string }>;
  createIssue(args: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels?: string[];
  }): Promise<{ number: number; url: string }>;
  upsertIssue(args: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels?: string[];
    matchTitle: string;
  }): Promise<{ number: number; url: string; created: boolean }>;
  getPr(target: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<{ title: string; body: string; diff: string; head: string; base: string; author: string }>;
  postReview(
    target: { owner: string; repo: string; number: number },
    args: {
      body: string;
      event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
      comments?: Array<{ path: string; line: number; body: string }>;
    }
  ): Promise<void>;
}

interface GithubIssue {
  id?: number | string;
  number: number;
  html_url: string;
  title?: string;
}

interface GithubPullRequest {
  title: string;
  body: string | null;
  head: { ref: string };
  base: { ref: string };
  user: { login: string };
}

function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export function createGithubClient(opts: IntegrationClientOptions): GithubClient {
  const request = <T>(operation: string, endpoint: string, init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    parseAs?: 'json' | 'text' | 'void';
  } = {}) => providerRequest<T>({
    provider: 'github',
    operation,
    client: opts,
    endpoint,
    ...init
  });

  return {
    async comment(target, body) {
      const issue = await request<GithubIssue>(
        'comment',
        `${repoPath(target.owner, target.repo)}/issues/${target.number}/comments`,
        { body: { body } }
      );
      return { id: String(issue.id), url: issue.html_url };
    },

    async createIssue(args) {
      const issue = await request<GithubIssue>(
        'createIssue',
        `${repoPath(args.owner, args.repo)}/issues`,
        { body: { title: args.title, body: args.body, labels: args.labels } }
      );
      return { number: issue.number, url: issue.html_url };
    },

    async upsertIssue(args) {
      const issues = await request<GithubIssue[]>(
        'upsertIssue.find',
        `${repoPath(args.owner, args.repo)}/issues?state=open&per_page=100`
      );
      const existing = issues.find((issue) => issue.title === args.matchTitle);
      if (!existing) {
        const created = await this.createIssue(args);
        return { ...created, created: true };
      }

      const updated = await request<GithubIssue>(
        'upsertIssue.update',
        `${repoPath(args.owner, args.repo)}/issues/${existing.number}`,
        {
          method: 'PATCH',
          body: { title: args.title, body: args.body, labels: args.labels }
        }
      );
      return { number: updated.number, url: updated.html_url, created: false };
    },

    async getPr(target) {
      const url = `${repoPath(target.owner, target.repo)}/pulls/${target.number}`;
      const [pr, diff] = await Promise.all([
        request<GithubPullRequest>('getPr', url),
        request<string>('getPr.diff', url, {
          headers: { accept: 'application/vnd.github.v3.diff' },
          parseAs: 'text'
        })
      ]);
      return {
        title: pr.title,
        body: pr.body ?? '',
        diff,
        head: pr.head.ref,
        base: pr.base.ref,
        author: pr.user.login
      };
    },

    async postReview(target, args) {
      await request<void>(
        'postReview',
        `${repoPath(target.owner, target.repo)}/pulls/${target.number}/reviews`,
        { body: args, parseAs: 'void' }
      );
    }
  };
}
