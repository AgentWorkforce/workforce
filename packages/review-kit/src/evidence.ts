import type { ReviewEvidenceProvider } from './types.js';

export interface PrDiffOptions {
  /** Repo-relative path cloud materializes. */
  path?: string;
  /** Optional changed-files companion path. */
  changedFilesPath?: string;
}

/** Validate the materialized diff before asking a harness to review it. */
export function prDiff(options: PrDiffOptions = {}): ReviewEvidenceProvider<'pr-diff'> {
  const path = options.path ?? '.workforce/pr.diff';
  const changedFilesPath = options.changedFilesPath ?? '.workforce/changed-files.txt';
  return {
    name: 'pr-diff',
    async collect({ ctx }) {
      let diff: string;
      try {
        diff = await ctx.sandbox.readFile(`${ctx.sandbox.cwd}/${path}`);
      } catch (error) {
        throw new Error(`review evidence is missing ${path}`, { cause: error });
      }
      if (!diff.trim()) {
        throw new Error(`review evidence ${path} is empty`);
      }
      return {
        title: 'Pull request diff',
        prompt: `Read ${path} for the complete change. Also read ${changedFilesPath} when present.`
      };
    }
  };
}

export interface GitHistoryOptions {
  /** Extra lens-specific directions appended after the safe defaults. */
  instructions?: string;
}

/** Prove git history exists, then expose read-only archaeology to the harness. */
export function gitHistory(
  options: GitHistoryOptions = {}
): ReviewEvidenceProvider<'git-history'> {
  return {
    name: 'git-history',
    async collect({ ctx }) {
      const result = await ctx.sandbox.exec('git rev-parse --is-inside-work-tree', {
        cwd: ctx.sandbox.cwd
      });
      if (result.exitCode !== 0 || result.output.trim() !== 'true') {
        throw new Error('review evidence requires a materialized git worktree');
      }
      const extra = options.instructions?.trim();
      return {
        title: 'Git history',
        prompt: [
          'Use read-only `git log`, `git show`, `git blame`, and `git log -S<symbol>` as evidence.',
          'If history is shallow or otherwise incomplete, say so instead of treating the boundary as the origin.',
          extra
        ]
          .filter(Boolean)
          .join(' ')
      };
    }
  };
}

/** Identity helper that preserves a custom provider's literal name in its type. */
export function defineReviewEvidence<const Name extends string>(
  provider: ReviewEvidenceProvider<Name>
): ReviewEvidenceProvider<Name> {
  return provider;
}
