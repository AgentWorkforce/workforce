import { createGithubClient, type GithubClient } from '@agentworkforce/runtime';
import type { WorkforceMcpConfig } from '../config.js';

/**
 * Integration tools are flat methods of the form
 * `integration.<provider>.<method>` (e.g. `integration.github.comment`).
 * Each provider is wired lazily — the MCP server constructs the client on
 * first call so harness invocations that never touch GitHub don't pay
 * for the auth setup.
 *
 * Tokens come from the same env convention deploy uses:
 * `WORKFORCE_INTEGRATION_<PROVIDER>_TOKEN`. Higher-level resolvers (the
 * Relayfile OAuth flow) plug in by extending the runtime's deploy
 * resolver — by the time the harness is spawned, the env is already
 * populated.
 */
export interface IntegrationToolDeps {
  config: WorkforceMcpConfig;
}

/** Provider clients lazily constructed and cached for the server's lifetime. */
type ProviderClient = GithubClient;

interface ClientCache {
  github?: GithubClient;
}

const clientCache: ClientCache = {};

/**
 * Top-level dispatcher. `tool` is a string like `integration.github.comment`;
 * args is whatever JSON the MCP caller sent. Returns the provider client
 * method's return value (or whatever JSON-safe shape it produced).
 */
export async function dispatchIntegration(
  tool: string,
  args: Record<string, unknown>,
  deps: IntegrationToolDeps
): Promise<unknown> {
  const segments = tool.split('.');
  if (segments.length !== 3 || segments[0] !== 'integration') {
    throw new Error(
      `integration tool name must be "integration.<provider>.<method>"; got "${tool}"`
    );
  }
  const [, provider, method] = segments;
  switch (provider) {
    case 'github':
      return invokeGithub(method, args, deps);
    default:
      throw new Error(
        `integration provider "${provider}" is not wired into the MCP server yet (only github ships in v1)`
      );
  }
}

/** Static list of available tool names — used for MCP listTools discovery. */
export const INTEGRATION_TOOL_NAMES = [
  'integration.github.comment',
  'integration.github.createIssue',
  'integration.github.upsertIssue',
  'integration.github.getPr',
  'integration.github.postReview'
] as const;

export type IntegrationToolName = (typeof INTEGRATION_TOOL_NAMES)[number];

async function invokeGithub(
  method: string,
  args: Record<string, unknown>,
  deps: IntegrationToolDeps
): Promise<unknown> {
  const client = resolveGithub(deps);
  switch (method) {
    case 'comment': {
      const { target, body } = asObject(args, 'integration.github.comment');
      return client.comment(asTarget(target), asNonEmptyString(body, 'body'));
    }
    case 'createIssue': {
      const fields = asObject(args, 'integration.github.createIssue');
      return client.createIssue({
        owner: asNonEmptyString(fields.owner, 'owner'),
        repo: asNonEmptyString(fields.repo, 'repo'),
        title: asNonEmptyString(fields.title, 'title'),
        body: asNonEmptyString(fields.body, 'body'),
        ...(Array.isArray(fields.labels) ? { labels: fields.labels.filter(isString) } : {})
      });
    }
    case 'upsertIssue': {
      const fields = asObject(args, 'integration.github.upsertIssue');
      return client.upsertIssue({
        owner: asNonEmptyString(fields.owner, 'owner'),
        repo: asNonEmptyString(fields.repo, 'repo'),
        title: asNonEmptyString(fields.title, 'title'),
        body: asNonEmptyString(fields.body, 'body'),
        matchTitle: asNonEmptyString(fields.matchTitle, 'matchTitle'),
        ...(Array.isArray(fields.labels) ? { labels: fields.labels.filter(isString) } : {})
      });
    }
    case 'getPr': {
      const { target } = asObject(args, 'integration.github.getPr');
      return client.getPr(asTarget(target));
    }
    case 'postReview': {
      const { target, review } = asObject(args, 'integration.github.postReview');
      const reviewObj = asObject(review, 'review');
      const eventField = reviewObj.event;
      if (eventField !== 'COMMENT' && eventField !== 'APPROVE' && eventField !== 'REQUEST_CHANGES') {
        throw new Error('review.event must be one of: COMMENT, APPROVE, REQUEST_CHANGES');
      }
      return client.postReview(asTarget(target), {
        body: asNonEmptyString(reviewObj.body, 'review.body'),
        event: eventField,
        ...(Array.isArray(reviewObj.comments)
          ? {
              comments: reviewObj.comments
                .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
                .map((c) => ({
                  path: asNonEmptyString(c.path, 'comment.path'),
                  line: asNumber(c.line, 'comment.line'),
                  body: asNonEmptyString(c.body, 'comment.body')
                }))
            }
          : {})
      });
    }
    default:
      throw new Error(`integration.github.${method} is not implemented`);
  }
}

function resolveGithub(deps: IntegrationToolDeps): ProviderClient {
  if (clientCache.github) return clientCache.github;
  const token = deps.config.providerTokens.github;
  if (!token) {
    throw new Error(
      'integration.github is not configured: set WORKFORCE_INTEGRATION_GITHUB_TOKEN before spawning the harness'
    );
  }
  clientCache.github = createGithubClient({ token });
  return clientCache.github;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${label}: expected an object argument`);
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label}: must be a non-empty string`);
  }
  return value;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}: must be a finite number`);
  }
  return value;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function asTarget(value: unknown): { owner: string; repo: string; number: number } {
  const obj = asObject(value, 'target');
  return {
    owner: asNonEmptyString(obj.owner, 'target.owner'),
    repo: asNonEmptyString(obj.repo, 'target.repo'),
    number: asNumber(obj.number, 'target.number')
  };
}

/** Reset the lazy client cache. Test-only — production has one server lifetime. */
export function _resetIntegrationCache(): void {
  delete clientCache.github;
}
