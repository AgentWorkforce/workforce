import {
  draftFile,
  encodeSegment,
  type IntegrationClientOptions,
  listDirectoryEntries,
  listJsonFiles,
  readJsonFile,
  readTextFile,
  writeJsonFile
} from './request.js';

/**
 * Relayfile-VFS-backed GitHub client. Same handler-side surface as the
 * direct-REST version this replaces; the difference is the wire — every
 * call now reads/writes JSON files at canonical paths under a Relayfile
 * mount, and Relayfile's writeback worker turns those into real GitHub
 * REST calls with retry/durability. Auth + token rotation happens in
 * Relayfile, not here, so personas don't have to thread a PAT through
 * env.
 */
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
  state?: string;
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

async function findNumberSegment(
  opts: IntegrationClientOptions,
  kind: 'issues' | 'pulls',
  owner: string,
  repo: string,
  number: number
): Promise<string> {
  // Relayfile may emit canonical paths under either `<n>/` or
  // `<n>__<slug>/` directories depending on the adapter version. Probe
  // both shapes; fall back to the raw number so reads still surface a
  // useful WorkforceIntegrationError if neither exists.
  const dir = `${repoRoot(owner, repo)}/${kind}`;
  const prefix = `${number}__`;
  const entries = await listDirectoryEntries(opts, 'github', `find.${kind}`, dir);
  return entries.find((entry) => entry === String(number) || entry.startsWith(prefix)) ?? String(number);
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
        id: result.receipt?.created ?? result.receipt?.id ?? result.path,
        url: result.receipt?.url ?? result.path
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
      return { number: Number.isFinite(number) ? number : 0, url: result.receipt?.url ?? result.path };
    },

    async upsertIssue(args) {
      const issueDir = `${repoRoot(args.owner, args.repo)}/issues`;
      const flatIssues = await listJsonFiles<GithubIssueFile>(opts, 'github', 'upsertIssue.find.flat', issueDir);
      const entries = await listDirectoryEntries(opts, 'github', 'upsertIssue.find.dirs', issueDir);
      const nestedIssueCandidates = await Promise.all(
        entries
          .filter((entry) => /^[1-9]\d*(?:__.*)?$/.test(entry))
          .map(async (entry) =>
            readJsonFile<GithubIssueFile>(
              opts,
              'github',
              'upsertIssue.find.meta',
              `${issueDir}/${entry}/meta.json`
            )
              .then((value) => ({ path: `${issueDir}/${entry}/meta.json`, value }))
              .catch(() => undefined)
          )
      );
      const nestedIssues = nestedIssueCandidates.filter((result): result is { path: string; value: GithubIssueFile } =>
        Boolean(result?.value.title)
      );
      const issues = [...flatIssues, ...nestedIssues];
      const existing = issues.find(
        (issue) => issue.value.state === 'open' && issue.value.title === args.matchTitle && issue.value.number
      );
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
      const pullSegment = await findNumberSegment(opts, 'pulls', target.owner, target.repo, target.number);
      const pullsRoot = `${repoRoot(target.owner, target.repo)}/pulls`;
      const pullRoot = `${pullsRoot}/${encodeSegment(pullSegment)}`;
      const pr = await readJsonFile<GithubPullRequestFile>(
        opts,
        'github',
        'getPr',
        `${pullRoot}/meta.json`
      ).catch(() =>
        readJsonFile<GithubPullRequestFile>(
          opts,
          'github',
          'getPr',
          `${pullRoot}/metadata.json`
        ).catch(() =>
          readJsonFile<GithubPullRequestFile>(
            opts,
            'github',
            'getPr',
            `${pullsRoot}/${encodeSegment(target.number)}.json`
          )
        )
      );
      const diff = await readTextFile(opts, 'github', 'getPr.diff', `${pullRoot}/diff.patch`).catch(() => '');
      return {
        title: pr.title ?? '',
        body: pr.body ?? '',
        diff: pr.diff ?? diff,
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
