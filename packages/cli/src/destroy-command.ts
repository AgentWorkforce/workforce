import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  createTerminalIO,
  formatHttpErrorBody,
  readActiveWorkspace,
  resolveCloudUrl,
  resolveWorkspaceToken
} from '@agentworkforce/deploy';

const USER_AGENT = 'agentworkforce-cli/destroy';
// UUID v1-v5, what the cloud agents.id column emits.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DestroyOptions {
  /** Either a persona file path (.json) or a literal agent UUID. */
  target: string;
  /** Workforce workspace id. Falls back to WORKFORCE_WORKSPACE_ID. */
  workspace?: string;
  /** Override cloud base URL. Falls back to env, then active.json, then the canonical default. */
  cloudUrl?: string;
  /** Fail instead of opening the browser to log in. */
  noPrompt?: boolean;
}

interface DestroyResponseBody {
  agentId: string;
  status: 'destroyed';
  destroyedAt: string;
  cancelledScheduleIds: string[];
}

interface AgentLookupBody {
  agent?: { id?: unknown; slug?: unknown } | null;
  agents?: Array<{ id?: unknown; slug?: unknown }> | null;
  id?: unknown;
}

/**
 * Internal sentinel error: lets `executeDestroy` choose a specific exit
 * code (1 = generic error, 2 = not-found / already-destroyed) without
 * calling `process.exit` directly inside helpers — which would clash
 * with test traps that turn `exit` into a throw.
 */
class DestroyExit extends Error {
  constructor(readonly exitCode: number, readonly userMessage: string) {
    super(userMessage);
    this.name = 'DestroyExit';
  }
}

/**
 * Argv parser + dispatcher for `agentworkforce destroy <persona-or-agent-id> [flags]`.
 * Mirrors the shape of runDeploy so cli.ts stays slim — destroy is a single
 * remote DELETE plus user-friendly resolution from persona file -> agentId.
 */
export async function runDestroy(args: readonly string[]): Promise<void> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    process.stdout.write(DESTROY_USAGE);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const parsed = parseDestroyArgs(args);

  let exitCode = 0;
  try {
    await executeDestroy(parsed);
  } catch (err) {
    if (err instanceof DestroyExit) {
      if (err.userMessage) {
        process.stderr.write(err.userMessage);
      }
      exitCode = err.exitCode;
    } else {
      process.stderr.write(
        `\nagentworkforce destroy failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
      exitCode = 1;
    }
  }
  process.exit(exitCode);
}

async function executeDestroy(opts: DestroyOptions): Promise<void> {
  const active = await readActiveWorkspace().catch(() => null);
  const cloudUrl = resolveCloudUrl({
    ...(opts.cloudUrl ? { flag: opts.cloudUrl } : {}),
    active
  });

  const io = createTerminalIO();
  const auth = await resolveWorkspaceToken({
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
    cloudUrl,
    io,
    ...(opts.noPrompt ? { noPrompt: true } : {})
  });
  const workspace = (
    auth.workspace
    ?? opts.workspace
    ?? process.env.WORKFORCE_WORKSPACE_ID
    ?? ''
  ).trim();
  if (!workspace) {
    throw new DestroyExit(
      1,
      '\nagentworkforce destroy failed: no workspace resolved: pass --workspace, set WORKFORCE_WORKSPACE_ID, or run `agentworkforce login`\n'
    );
  }
  const token = auth.token;

  const agentId = await resolveAgentId({
    target: opts.target,
    cloudUrl,
    workspace,
    token
  });

  const url = `${cloudUrl}/api/v1/workspaces/${encodeURIComponent(
    workspace
  )}/deployments/${encodeURIComponent(agentId)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': USER_AGENT
    }
  });

  if (res.status === 401) {
    throw new DestroyExit(
      1,
      '\nagentworkforce destroy failed: unauthorized. Run `agentworkforce login` and retry.\n'
    );
  }
  if (res.status === 404) {
    // Exit 2 is the documented "not found / already destroyed" signal so
    // scripts can distinguish it from a generic 1.
    throw new DestroyExit(2, `\nagent not found or already destroyed: ${agentId}\n`);
  }
  if (!res.ok) {
    throw new DestroyExit(
      1,
      `\nagentworkforce destroy failed: ${res.status} ${await responseExcerpt(res)}\n`
    );
  }

  const body = (await res.json().catch(() => null)) as DestroyResponseBody | null;
  if (!body || body.status !== 'destroyed' || typeof body.agentId !== 'string') {
    throw new DestroyExit(
      1,
      '\nagentworkforce destroy failed: server returned an unexpected response shape\n'
    );
  }

  const count = Array.isArray(body.cancelledScheduleIds) ? body.cancelledScheduleIds.length : 0;
  process.stdout.write(`destroyed: ${body.agentId}\ncancelled schedules: ${count}\n`);
}

async function resolveAgentId(args: {
  target: string;
  cloudUrl: string;
  workspace: string;
  token: string;
}): Promise<string> {
  if (UUID_RE.test(args.target)) {
    return args.target;
  }

  const looksLikePersonaFile =
    args.target.endsWith('.json') || (await pathExists(args.target));
  if (!looksLikePersonaFile) {
    // Neither a UUID nor an obvious persona path — accept as-is so callers
    // can pass deterministic slugs the server understands, but it will most
    // likely 404 below and surface a clean error.
    return args.target;
  }

  const absPath = path.resolve(args.target);
  const raw = await readFile(absPath, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      throw new Error(`persona JSON not found at ${absPath}`);
    }
    throw err;
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `persona JSON at ${absPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`persona JSON at ${absPath} must be a top-level object`);
  }
  const slug = (parsed as { slug?: unknown; id?: unknown }).slug;
  const id = (parsed as { id?: unknown }).id;
  const lookupSlug =
    typeof slug === 'string' && slug.trim()
      ? slug.trim()
      : typeof id === 'string' && id.trim()
        ? id.trim()
        : null;
  if (!lookupSlug) {
    throw new Error(`persona JSON at ${absPath} is missing "id" / "slug"`);
  }

  const url = `${args.cloudUrl}/api/v1/workspaces/${encodeURIComponent(
    args.workspace
  )}/agents?persona_slug=${encodeURIComponent(lookupSlug)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${args.token}`,
      'user-agent': USER_AGENT
    }
  });

  if (res.status === 401) {
    throw new Error('unauthorized while looking up the deployed agent: run `agentworkforce login` and retry');
  }
  // 404/405 here means the server doesn't have a deployed agent for this
  // persona — surface as the same exit-2 signal we use for explicit
  // already-destroyed targets.
  if (res.status === 404 || res.status === 405) {
    throw new DestroyExit(2, `\nno deployed agent found for persona "${lookupSlug}"\n`);
  }
  if (!res.ok) {
    throw new Error(
      `agent lookup failed: ${res.status} ${await responseExcerpt(res)}; pass the agent UUID directly`
    );
  }

  const body = (await res.json().catch(() => null)) as AgentLookupBody | null;
  const resolved = extractAgentId(body);
  if (!resolved) {
    throw new Error(
      `agent lookup for "${lookupSlug}" returned no agent id; pass the agent UUID directly`
    );
  }
  return resolved;
}

function extractAgentId(body: AgentLookupBody | null): string | null {
  if (!body) return null;
  if (typeof body.id === 'string' && body.id.trim()) return body.id.trim();
  if (body.agent && typeof body.agent.id === 'string' && body.agent.id.trim()) {
    return body.agent.id.trim();
  }
  if (Array.isArray(body.agents)) {
    for (const candidate of body.agents) {
      if (candidate && typeof candidate.id === 'string' && candidate.id.trim()) {
        return candidate.id.trim();
      }
    }
  }
  return null;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    const stats = await stat(path.resolve(target));
    return stats.isFile();
  } catch {
    return false;
  }
}

async function responseExcerpt(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return formatHttpErrorBody(text, { url: res.url, maxLength: 200 });
  } catch {
    return '';
  }
}

export const DESTROY_USAGE = `usage: agentworkforce destroy <persona-or-agent-id> [flags]

Tear down a deployed agent: cancel all relaycron schedules and mark the
agent as destroyed in the workspace. Accepts either a persona JSON path
(slug/id is resolved via the workspace's agents index) or a literal agent
UUID.

Flags:
  --workspace <id>     Workforce workspace; defaults to WORKFORCE_WORKSPACE_ID
  --cloud-url <url>    Override the workforce cloud base URL
  --no-prompt          Fail instead of opening the browser to log in
  -h, --help           Print this message

Exit codes:
  0   destroyed
  2   agent not found or already destroyed
  1   any other error
`;

export function parseDestroyArgs(args: readonly string[]): DestroyOptions {
  let target: string | undefined;
  let workspace: string | undefined;
  let cloudUrl: string | undefined;
  let noPrompt = false;

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(DESTROY_USAGE);
      process.exit(0);
    } else if (a === '--workspace') {
      workspace = expectValue('--workspace', args[++i]);
    } else if (a.startsWith('--workspace=')) {
      workspace = expectInlineValue('--workspace', a.slice('--workspace='.length));
    } else if (a === '--cloud-url') {
      cloudUrl = expectValue('--cloud-url', args[++i]);
    } else if (a.startsWith('--cloud-url=')) {
      cloudUrl = expectInlineValue('--cloud-url', a.slice('--cloud-url='.length));
    } else if (a === '--no-prompt') {
      noPrompt = true;
    } else if (a.startsWith('--')) {
      die(`destroy: unknown flag "${a}"`);
    } else if (!target) {
      target = a;
    } else {
      die(`destroy: unexpected positional argument "${a}"`);
    }
  }

  if (!target) {
    die('destroy: missing persona path or agent id. Usage: agentworkforce destroy <persona-or-agent-id>');
  }

  return {
    target,
    ...(workspace ? { workspace } : {}),
    ...(cloudUrl ? { cloudUrl } : {}),
    ...(noPrompt ? { noPrompt: true } : {})
  };
}

function expectValue(flag: string, value: string | undefined): string {
  if (typeof value !== 'string' || !value.trim()) {
    die(`${flag}: missing value`);
  }
  if (value.startsWith('-')) {
    die(`${flag}: missing value (got "${value}", which looks like a flag)`);
  }
  return value;
}

function expectInlineValue(flag: string, value: string): string {
  if (!value.trim()) {
    die(`${flag}: missing value`);
  }
  return value;
}

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
