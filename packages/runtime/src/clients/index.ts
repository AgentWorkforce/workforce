export {
  createGithubClient,
  type GithubClient,
  type GithubClientOptions,
  type GithubIssueRef,
  type GithubIssueTarget,
  type GithubPr,
  type GithubRepoCoords,
  type GithubReview,
  type GithubReviewComment,
  type GithubUpsertResult
} from './github.js';

export { WorkforceIntegrationError, isRetryableStatus } from './errors.js';
