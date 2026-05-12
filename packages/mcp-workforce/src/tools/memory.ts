import type { PersonaMemoryScope } from '@agentworkforce/persona-kit';
import type { WorkforceMcpConfig } from '../config.js';

/**
 * Memory tools speak directly to the Supermemory REST API so the MCP
 * package stays free of heavy adapter dependencies. The endpoint and
 * payload shape mirror the contract `@agent-assistant/memory` uses, so a
 * workspace's memories written by sage or any other consumer are visible
 * to a harness running under workforce — there's one supermemory project
 * per workspace and we route by tag.
 */
const SUPERMEMORY_DEFAULT_ENDPOINT = 'https://api.supermemory.ai';

export interface MemoryItem {
  id: string;
  content: string;
  tags: string[];
  scope: PersonaMemoryScope;
  createdAt: string;
}

export interface MemorySaveArgs {
  content: string;
  tags?: string[];
  scope?: PersonaMemoryScope;
}

export interface MemoryRecallArgs {
  query: string;
  limit?: number;
}

export interface MemoryToolDeps {
  config: WorkforceMcpConfig;
  fetchImpl?: typeof fetch;
}

const VALID_SCOPES: ReadonlySet<PersonaMemoryScope> = new Set([
  'session',
  'user',
  'workspace',
  'org',
  'object'
]);

/**
 * `memory.save` — writes a memory entry under the active workspace. Tags
 * include the supplied tags plus a synthetic `workspace:<id>` tag and a
 * `scope:<scope>` tag so callers can filter on recall.
 */
export async function memorySave(args: MemorySaveArgs, deps: MemoryToolDeps): Promise<{ ok: true; id: string }> {
  if (!args.content || !args.content.trim()) {
    throw new Error('memory.save: "content" is required');
  }
  const scope: PersonaMemoryScope = args.scope ?? 'workspace';
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`memory.save: invalid scope "${scope}"`);
  }
  requireSupermemoryKey(deps.config);

  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${memoryEndpoint(deps.config)}/v3/memories`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: memoryHeaders(deps.config),
    body: JSON.stringify({
      content: args.content,
      containerTag: workspaceContainer(deps.config),
      metadata: {
        workspaceId: deps.config.workspaceId,
        ...(deps.config.personaId ? { personaId: deps.config.personaId } : {}),
        scope
      },
      tags: dedupeTags([
        `workspace:${deps.config.workspaceId}`,
        `scope:${scope}`,
        ...(args.tags ?? [])
      ])
    })
  });
  if (!response.ok) {
    throw await toError(response, 'memory.save');
  }
  const payload = (await response.json()) as { id?: string };
  if (!payload?.id) {
    throw new Error('memory.save: supermemory response missing id');
  }
  return { ok: true, id: payload.id };
}

/** `memory.recall` — semantic search over the workspace's memory bag. */
export async function memoryRecall(
  args: MemoryRecallArgs,
  deps: MemoryToolDeps
): Promise<{ items: MemoryItem[] }> {
  if (!args.query || !args.query.trim()) {
    throw new Error('memory.recall: "query" is required');
  }
  const limit = args.limit ?? 5;
  if (!Number.isFinite(limit) || limit <= 0 || limit > 50) {
    throw new Error('memory.recall: "limit" must be 1-50');
  }
  requireSupermemoryKey(deps.config);

  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${memoryEndpoint(deps.config)}/v3/search`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: memoryHeaders(deps.config),
    body: JSON.stringify({
      q: args.query,
      containerTag: workspaceContainer(deps.config),
      limit
    })
  });
  if (!response.ok) {
    throw await toError(response, 'memory.recall');
  }
  const payload = (await response.json()) as {
    results?: Array<{
      id: string;
      content?: string;
      memory?: string;
      tags?: string[];
      metadata?: { scope?: PersonaMemoryScope };
      createdAt?: string;
      created_at?: string;
    }>;
  };
  const results = payload.results ?? [];
  const items: MemoryItem[] = results.map((entry) => ({
    id: entry.id,
    content: entry.content ?? entry.memory ?? '',
    tags: entry.tags ?? [],
    scope: entry.metadata?.scope ?? 'workspace',
    createdAt: entry.createdAt ?? entry.created_at ?? ''
  }));
  return { items };
}

function workspaceContainer(config: WorkforceMcpConfig): string {
  return `workforce:${config.workspaceId}`;
}

function memoryEndpoint(config: WorkforceMcpConfig): string {
  return (config.supermemoryEndpoint ?? SUPERMEMORY_DEFAULT_ENDPOINT).replace(/\/$/, '');
}

function memoryHeaders(config: WorkforceMcpConfig): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${config.supermemoryApiKey}`,
    'user-agent': 'mcp-workforce'
  };
}

function requireSupermemoryKey(config: WorkforceMcpConfig): asserts config is WorkforceMcpConfig & {
  supermemoryApiKey: string;
} {
  if (!config.supermemoryApiKey) {
    throw new Error(
      'memory tools require SUPERMEMORY_API_KEY in the env. Set it before spawning the harness, or disable memory tools by not configuring it.'
    );
  }
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

async function toError(response: Response, label: string): Promise<Error> {
  const body = await response.text().catch(() => '');
  const excerpt = body.length > 400 ? `${body.slice(0, 400)}…` : body;
  return new Error(
    `${label}: ${response.status} ${response.statusText}${excerpt ? ` — ${excerpt}` : ''}`
  );
}
