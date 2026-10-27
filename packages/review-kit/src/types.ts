import type { WorkforceCtx } from '@agentworkforce/runtime';

/** GitHub's canonical owner/repository slug. Runtime validation rejects extra segments. */
export type GitHubRepository = `${string}/${string}`;

export interface ReviewPullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  draft: boolean;
  labels: readonly string[];
  /** The immutable PR revision used as the writeback idempotency key. */
  headSha?: string;
}

export interface ReviewEvidence {
  /** Short heading used to keep evidence instructions distinguishable in the prompt. */
  title: string;
  /** Instructions or gathered context for the review harness. */
  prompt: string;
}

export interface ReviewEvidenceContext {
  ctx: WorkforceCtx;
  pullRequest: ReviewPullRequest;
  payload: unknown;
  charterPath: string;
}

/**
 * The extension point for differentiated reviewers. A provider may validate
 * local evidence, gather remote evidence, or supply instructions for evidence
 * already materialized into the checkout.
 */
export interface ReviewEvidenceProvider<Name extends string = string> {
  readonly name: Name;
  collect(context: ReviewEvidenceContext): ReviewEvidence | Promise<ReviewEvidence>;
}

export type ReviewEvidenceList = readonly [
  ReviewEvidenceProvider,
  ...ReviewEvidenceProvider[]
];
