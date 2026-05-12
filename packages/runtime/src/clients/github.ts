import {
  draftFile,
  encodeSegment,
  type IntegrationClientOptions,
  listJsonFiles,
  readJsonFile,
  writeJsonFile
} from './request.js';

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

interface GithubIssueFile {
  number?: number;
  html_url?: string;
  url?: string;
  title?: string;
}

interface GithubPullRequestFile {
  title?: string;
  body?: string | null;
  head?: { ref?: string } | string;
  base?: { ref?: string } | string;
  user?: { login?: string } | string;
  author?: string;
  diff?: string;
}

function repoRoot(owner: string, repo: string): string {
  return `/github/repos/${encodeSegment(owner)}/${encodeSegment(repo)}`;
}

function readRef(value: GithubPullRequestFile['head']): string {
  if (typeof value === 'string') return value;
  return value?.ref ?? '';
}

function readAuthor(value: GithubPullRequestFile): string {
  if (typeof value.user === 'string') return value.user;
  return value.user?.login ?? value.author ?? '';
}

export function createGithubClient(opts: IntegrationClientOptions): GithubClient {
  return {
    async comment(target, body) {
      const result = await writeJsonFile(
        opts,
        'github',
        'comment',
        `${repoRoot(target.owner, target.repo)}/issues/${encodeSegment(target.number)}/comments/${draftFile('create comment')}`,
        { body }
      );
      return {
        id: result.receipt?.created ?? result.receipt?.id ?? '',
        url: result.receipt?.url ?? ''
      };
    },

    async createIssue(args) {
      const result = await writeJsonFile(
        opts,
        'github',
        'createIssue',
        `${repoRoot(args.owner, args.repo)}/issues/${draftFile('create issue')}`,
        { title: args.title, body: args.body, labels: args.labels }
      );
      const number = Number(result.receipt?.created ?? result.receipt?.id ?? 0);
      return { number: Number.isFinite(number) ? number : 0, url: result.receipt?.url ?? '' };
    },

    async upsertIssue(args) {
      const issueDir = `${repoRoot(args.owner, args.repo)}/issues`;
      const issues = await listJsonFiles<GithubIssueFile>(opts, 'github', 'upsertIssue.find', issueDir);
      const existing = issues.find((issue) => issue.value.title === args.matchTitle && issue.value.number);
      if (existing?.value.number) {
        await writeJsonFile(
          opts,
          'github',
          'upsertIssue.update',
          `${issueDir}/${encodeSegment(existing.value.number)}.json`,
          { title: args.title, body: args.body, labels: args.labels }
        );
        return {
          number: existing.value.number,
          url: existing.value.html_url ?? existing.value.url ?? '',
          created: false
        };
      }
      const created = await this.createIssue(args);
      return { ...created, created: true };
    },

    async getPr(target) {
      const pr = await readJsonFile<GithubPullRequestFile>(
        opts,
        'github',
        'getPr',
        `${repoRoot(target.owner, target.repo)}/pulls/${encodeSegment(target.number)}/metadata.json`
      );
      return {
        title: pr.title ?? '',
        body: pr.body ?? '',
        diff: pr.diff ?? '',
        head: readRef(pr.head),
        base: readRef(pr.base),
        author: readAuthor(pr)
      };
    },

    async postReview(target, args) {
      await writeJsonFile(
        opts,
        'github',
        'postReview',
        `${repoRoot(target.owner, target.repo)}/pulls/${encodeSegment(target.number)}/reviews/${draftFile('create review')}`,
        { ...args, comments: args.comments ?? [] }
      );
    }
  };
}
