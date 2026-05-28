import {
  draftFile,
  encodeSegment,
  readJsonFile,
  resolveMountRoot,
  writeJsonFile,
  type IntegrationClientOptions
} from '@agentworkforce/runtime';
import type { WorkforceMcpConfig } from '../config.js';

/**
 * Integration tools are flat methods of the form
 * `integration.<provider>.<method>` (e.g. `integration.github.comment`).
 * Each provider is wired lazily — the MCP server constructs the client
 * options on first call so harness invocations that never touch GitHub
 * don't pay for the setup.
 *
 * Workforce integrations are Relayfile-VFS-backed: tools write canonical
 * JSON files inside the Relayfile mount and the writeback worker turns
 * those into real provider API calls. The MCP server picks up the mount
 * root from `RELAYFILE_MOUNT_ROOT` (or `RELAYFILE_ROOT`); the runtime
 * sets this automatically when it spawns the harness via `ctx.harness.run`.
 */
export interface IntegrationToolDeps {
  config: WorkforceMcpConfig;
}

/** IntegrationClientOptions cached by mount root. */
interface ClientCache {
  github?: IntegrationClientOptions;
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
      const { owner, repo, number } = asTarget(target);
      const result = await writeJsonFile(client, 'github', 'comment',
        `/github/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/issues/${number}/comments/${draftFile('comment')}`,
        { body });
      return {
        id: result.receipt?.id ?? result.receipt?.created ?? '',
        url: result.receipt?.url ?? result.path
      };
    }
    case 'createIssue': {
      const fields = asObject(args, 'integration.github.createIssue');
      const owner = asNonEmptyString(fields.owner, 'owner');
      const repo = asNonEmptyString(fields.repo, 'repo');
      const result = await writeJsonFile(client, 'github', 'createIssue',
        `/github/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/issues/${draftFile('create issue')}`,
        {
          title: asNonEmptyString(fields.title, 'title'),
          body: asNonEmptyString(fields.body, 'body'),
          ...(Array.isArray(fields.labels) ? { labels: fields.labels.filter(isString) } : {})
        });
      return {
        id: result.receipt?.id ?? '',
        identifier: result.receipt?.identifier ?? '',
        url: result.receipt?.url ?? result.path
      };
    }
    case 'upsertIssue': {
      const fields = asObject(args, 'integration.github.upsertIssue');
      const owner = asNonEmptyString(fields.owner, 'owner');
      const repo = asNonEmptyString(fields.repo, 'repo');
      const result = await writeJsonFile(client, 'github', 'upsertIssue',
        `/github/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/issues/${draftFile('upsert issue')}`,
        {
          title: asNonEmptyString(fields.title, 'title'),
          body: asNonEmptyString(fields.body, 'body'),
          matchTitle: asNonEmptyString(fields.matchTitle, 'matchTitle'),
          ...(Array.isArray(fields.labels) ? { labels: fields.labels.filter(isString) } : {})
        });
      return {
        id: result.receipt?.id ?? '',
        identifier: result.receipt?.identifier ?? '',
        url: result.receipt?.url ?? result.path
      };
    }
    case 'getPr': {
      const { owner, repo, number } = asTarget(args);
      const pr = await readJsonFile<{ title?: string; body?: string; state?: string; url?: string; [key: string]: unknown }>(
        client, 'github', 'getPr',
        `/github/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/pulls/${number}.json`);
      return {
        title: pr.title,
        body: pr.body,
        state: pr.state,
        url: pr.url,
        data: pr
      };
    }
    case 'postReview': {
      const { target, review } = asObject(args, 'integration.github.postReview');
      const { owner, repo, number } = asTarget(target);
      const reviewObj = asObject(review, 'review');
      const eventField = reviewObj.event;
      if (eventField !== 'COMMENT' && eventField !== 'APPROVE' && eventField !== 'REQUEST_CHANGES') {
        throw new Error('review.event must be one of: COMMENT, APPROVE, REQUEST_CHANGES');
      }
      const result = await writeJsonFile(client, 'github', 'postReview',
        `/github/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/pulls/${number}/reviews/${draftFile('review')}`,
        {
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
      return {
        id: result.receipt?.id ?? '',
        url: result.receipt?.url ?? result.path
      };
    }
    default:
      throw new Error(`integration.github.${method} is not implemented`);
  }
}

function resolveGithub(deps: IntegrationToolDeps): IntegrationClientOptions {
  if (clientCache.github) return clientCache.github;
  if (!deps.config.relayfileMountRoot) {
    throw new Error(
      'integration.github is not configured: RELAYFILE_MOUNT_ROOT is required so the github client can write drafts into the Relayfile mount. The workforce runtime sets this automatically when spawning the harness via ctx.harness.run.'
    );
  }
  clientCache.github = {
    relayfileMountRoot: deps.config.relayfileMountRoot,
    writebackTimeoutMs: deps.config.writebackTimeoutMs
  };
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