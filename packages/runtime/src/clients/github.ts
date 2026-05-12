import { isRetryableStatus, WorkforceIntegrationError } from './errors.js';

export interface GithubIssueTarget {
  owner: string;
  repo: string;
  number: number;
}

export interface GithubRepoCoords {
  owner: string;
  repo: string;
}

export interface GithubIssueRef {
  number: number;
  url: string;
}

export interface GithubUpsertResult extends GithubIssueRef {
  created: boolean;
}

export interface GithubReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface GithubReview {
  body: string;
  event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
  comments?: GithubReviewComment[];
}

export interface GithubPr {
  title: string;
  body: string;
  diff: string;
  head: string;
  base: string;
  author: string;
}

/**
 * Minimal GitHub client used by personas. Today it covers the operations
 * weekly-digest and review-agent need; we grow it by need rather than
 * mirroring the full REST surface.
 */
export interface GithubClient {
  comment(target: GithubIssueTarget, body: string): Promise<GithubIssueRef>;
  createIssue(args: GithubRepoCoords & { title: string; body: string; labels?: string[] }): Promise<GithubIssueRef>;
  upsertIssue(args: GithubRepoCoords & { title: string; body: string; labels?: string[]; matchTitle: string }): Promise<GithubUpsertResult>;
  getPr(target: GithubIssueTarget): Promise<GithubPr>;
  postReview(target: GithubIssueTarget, review: GithubReview): Promise<void>;
}

export interface GithubClientOptions {
  /** Bearer token. Either a PAT or a Relayfile-issued scoped token. */
  token: string;
  /** Override for GitHub Enterprise. Defaults to api.github.com. */
  apiUrl?: string;
  /** Optional fetch override (tests + custom transports). */
  fetchImpl?: typeof fetch;
}

/**
 * Construct a real GitHub client. The token is sent on every request as
 * a Bearer credential, matching both PAT and GitHub App installation
 * token conventions.
 */
export function createGithubClient(opts: GithubClientOptions): GithubClient {
  const apiUrl = (opts.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function request<T>(
    operation: string,
    init: { method: string; pathname: string; body?: unknown; accept?: string; responseType?: 'json' | 'text' }
  ): Promise<T> {
    const url = `${apiUrl}${init.pathname}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: init.method,
        headers: {
          accept: init.accept ?? 'application/vnd.github+json',
          authorization: `Bearer ${opts.token}`,
          'x-github-api-version': '2022-11-28',
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          'user-agent': 'workforce-runtime'
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
      });
    } catch (err) {
      throw new WorkforceIntegrationError({
        provider: 'github',
        operation,
        message: `network error: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
        cause: err
      });
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new WorkforceIntegrationError({
        provider: 'github',
        operation,
        message: `${response.status} ${response.statusText}${bodyText ? ` — ${truncate(bodyText, 400)}` : ''}`,
        status: response.status,
        retryable: isRetryableStatus(response.status)
      });
    }

    if (response.status === 204) return undefined as T;
    if (init.responseType === 'text') return (await response.text()) as unknown as T;
    return (await response.json()) as T;
  }

  return {
    async comment(target, body) {
      const out = await request<{ id: number; html_url: string }>('comment', {
        method: 'POST',
        pathname: `/repos/${target.owner}/${target.repo}/issues/${target.number}/comments`,
        body: { body }
      });
      return { number: target.number, url: out.html_url };
    },
    async createIssue(args) {
      const out = await request<{ number: number; html_url: string }>('createIssue', {
        method: 'POST',
        pathname: `/repos/${args.owner}/${args.repo}/issues`,
        body: {
          title: args.title,
          body: args.body,
          ...(args.labels ? { labels: args.labels } : {})
        }
      });
      return { number: out.number, url: out.html_url };
    },
    async upsertIssue(args) {
      const search = await request<{
        items: Array<{ number: number; title: string; html_url: string; state: string }>;
      }>('upsertIssue.search', {
        method: 'GET',
        pathname: `/search/issues?q=${encodeURIComponent(
          `repo:${args.owner}/${args.repo} in:title is:issue "${args.matchTitle}"`
        )}&per_page=10`
      });
      const exact = search.items.find(
        (item) => item.title === args.matchTitle && item.state === 'open'
      );
      if (exact) {
        await request<unknown>('upsertIssue.edit', {
          method: 'PATCH',
          pathname: `/repos/${args.owner}/${args.repo}/issues/${exact.number}`,
          body: {
            body: args.body,
            ...(args.labels ? { labels: args.labels } : {})
          }
        });
        return { number: exact.number, url: exact.html_url, created: false };
      }
      const created = await request<{ number: number; html_url: string }>('upsertIssue.create', {
        method: 'POST',
        pathname: `/repos/${args.owner}/${args.repo}/issues`,
        body: {
          title: args.matchTitle === args.title ? args.title : args.matchTitle,
          body: args.body,
          ...(args.labels ? { labels: args.labels } : {})
        }
      });
      return { number: created.number, url: created.html_url, created: true };
    },
    async getPr(target) {
      const pr = await request<{
        title: string;
        body: string | null;
        head: { ref: string };
        base: { ref: string };
        user: { login: string } | null;
      }>('getPr.metadata', {
        method: 'GET',
        pathname: `/repos/${target.owner}/${target.repo}/pulls/${target.number}`
      });
      // Fetch the diff through the canonical API endpoint with the same
      // configured host + auth pipeline, not whatever URL the previous
      // response handed us. Using `request` keeps the bearer token scoped
      // to `apiUrl` and reuses the WorkforceIntegrationError mapping.
      const diff = await request<string>('getPr.diff', {
        method: 'GET',
        pathname: `/repos/${target.owner}/${target.repo}/pulls/${target.number}`,
        accept: 'application/vnd.github.v3.diff',
        responseType: 'text'
      });
      return {
        title: pr.title,
        body: pr.body ?? '',
        diff,
        head: pr.head.ref,
        base: pr.base.ref,
        author: pr.user?.login ?? ''
      };
    },
    async postReview(target, review) {
      await request<unknown>('postReview', {
        method: 'POST',
        pathname: `/repos/${target.owner}/${target.repo}/pulls/${target.number}/reviews`,
        body: {
          body: review.body,
          event: review.event,
          ...(review.comments
            ? {
                comments: review.comments.map((c) => ({ path: c.path, line: c.line, body: c.body }))
              }
            : {})
        }
      });
    }
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
