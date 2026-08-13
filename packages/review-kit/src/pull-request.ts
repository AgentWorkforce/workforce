import type { ReviewPullRequest } from './types.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function sha(value: unknown): string | undefined {
  const candidate = nonBlankString(value);
  return candidate && /^[a-f\d]{7,64}$/iu.test(candidate) ? candidate.toLowerCase() : undefined;
}

function labels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((label) => {
    if (typeof label === 'string' && label.trim()) return [label.trim()];
    const name = nonBlankString(record(label)?.name);
    return name ? [name] : [];
  });
}

/** Accept browser and API pull-request URLs without coupling to github.com hosting. */
export function repositoryFromPullRequestUrl(
  value: string | undefined
): { owner: string; repo: string } | null {
  if (!value) return null;
  const match = /\/(?:repos\/)?([^/?#]+)\/([^/?#]+)\/pulls?\/\d+(?:[/?#]|$)/u.exec(value);
  if (!match) return null;
  try {
    return { owner: decodeURIComponent(match[1]), repo: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

/**
 * Read every PR event shape currently delivered by GitHub/Relayfile.
 *
 * In particular, the production event is a PR object flattened at the root,
 * with `repository` beside it and a `pull_request` links object that has no
 * number. Requiring `pull_request.number` silently skips every such event.
 */
export function readPullRequest(value: unknown): ReviewPullRequest | null {
  const root = record(value);
  if (!root) return null;

  const pull = record(root.pull_request) ?? record(root.pullRequest);
  const repository = record(root.repository);
  const number = positiveInteger(root.number) ?? positiveInteger(pull?.number);

  if (repository && number !== undefined) {
    const fullName = nonBlankString(repository.full_name);
    const owner =
      nonBlankString(record(repository.owner)?.login) ??
      nonBlankString(repository.owner) ??
      fullName?.split('/')[0];
    const repo = nonBlankString(repository.name) ?? fullName?.split('/')[1];
    if (owner && repo) {
      const head = record(root.head) ?? record(pull?.head);
      return {
        owner,
        repo,
        number,
        title: nonBlankString(root.title) ?? nonBlankString(pull?.title) ?? `PR #${number}`,
        draft: root.draft === true || pull?.draft === true,
        labels: labels(root.labels ?? pull?.labels),
        headSha:
          sha(root.head_sha) ?? sha(root.headSha) ?? sha(head?.sha) ?? sha(pull?.head_sha)
      };
    }
  }

  // Normalized Relayfile record. It may arrive wrapped in `payload`, or the
  // runtime may already have handed the handler that inner record.
  const body = record(root.payload) ?? root;
  const normalizedNumber =
    positiveInteger(body.number) ?? positiveInteger(root.objectId) ?? positiveInteger(root.object_id);
  const fromUrl = repositoryFromPullRequestUrl(
    nonBlankString(body.html_url) ?? nonBlankString(body.url)
  );
  if (normalizedNumber === undefined || !fromUrl) return null;
  const head = record(body.head);

  return {
    owner: fromUrl.owner,
    repo: fromUrl.repo,
    number: normalizedNumber,
    title: nonBlankString(body.title) ?? `PR #${normalizedNumber}`,
    draft: body.draft === true,
    labels: labels(body.labels),
    headSha: sha(body.head_sha) ?? sha(body.headSha) ?? sha(head?.sha)
  };
}

export function hasSkipLabel(
  pullRequest: Pick<ReviewPullRequest, 'labels'>,
  skipLabels: readonly string[]
): string | null {
  const present = new Set(pullRequest.labels.map((label) => label.toLowerCase()));
  return skipLabels.find((label) => present.has(label.toLowerCase())) ?? null;
}
