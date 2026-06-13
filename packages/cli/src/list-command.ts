import {
  createTerminalIO,
  formatHttpErrorBody,
  resolveCloudUrl,
  resolveWorkspaceToken
} from '@agentworkforce/deploy';

type DeploymentListOptions = {
  workspace?: string;
  status?: string;
  persona?: string;
  json?: boolean;
  cloudUrl?: string;
  noPrompt?: boolean;
};

type DeploymentLogsOptions = {
  selector?: string;
  workspace?: string;
  path?: string;
  tail: number;
  json?: boolean;
  cloudUrl?: string;
  noPrompt?: boolean;
};

export type DeploymentAgent = {
  agentId: string;
  personaId: string;
  personaSlug: string;
  deployedName: string;
  status: string;
  createdAt: string;
  lastUsedAt: string | null;
  scheduleIds: string[];
  deployedByUserId: string;
};

type ListResponse = {
  agents?: unknown;
};

type LogsListResponse = {
  data?: {
    workspace?: unknown;
    items?: unknown;
    nextCursor?: unknown;
  };
};

type LogsReadResponse = {
  data?: {
    workspace?: unknown;
    path?: unknown;
    entries?: unknown;
  };
};

type LogEntry = Record<string, unknown>;

export async function runDeploymentList(args: readonly string[]): Promise<void> {
  if (args.length > 0 && (args[0] === '-h' || args[0] === '--help')) {
    process.stdout.write(LIST_USAGE);
    process.exit(0);
  }

  try {
    const opts = parseDeploymentListArgs(args);
    const io = createTerminalIO();
    const cloudUrl = resolveCloudUrl({
      ...(opts.cloudUrl ? { flag: opts.cloudUrl } : {})
    });
    const auth = await resolveWorkspaceToken({
      ...(opts.workspace ? { workspace: opts.workspace } : {}),
      cloudUrl,
      io,
      ...(opts.noPrompt ? { noPrompt: true } : {})
    });
    const workspace = auth.workspace?.trim() || opts.workspace?.trim();
    if (!workspace) {
      throw new Error('workspace is required: pass --workspace, set WORKFORCE_WORKSPACE_ID, or run `agentworkforce login`');
    }

    const url = new URL(`${cloudUrl}/api/v1/workspaces/${encodeURIComponent(workspace)}/deployments`);
    if (opts.status) url.searchParams.set('status', opts.status);
    if (opts.persona) url.searchParams.set('personaId', opts.persona);

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${auth.token}`,
        'user-agent': 'agentworkforce-cli'
      }
    });
    if (res.status === 401) {
      throw new Error('unauthorized. Run `agentworkforce login` and retry.');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const hint = formatHttpErrorBody(body, { url: url.toString() });
      throw new Error(`list failed: ${res.status}${hint ? ` ${hint}` : ''}`);
    }
    const agents = parseAgents((await res.json()) as ListResponse);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ agents }, null, 2)}\n`);
    } else {
      process.stdout.write(formatDeploymentsTable(agents));
      process.stdout.write(`\n${agents.length} agent(s).\n`);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `\nagentworkforce list failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}

export async function runDeploymentLogs(args: readonly string[]): Promise<void> {
  if (args.length > 0 && (args[0] === '-h' || args[0] === '--help')) {
    process.stdout.write(LOGS_USAGE);
    process.exit(0);
  }

  try {
    const opts = parseDeploymentLogsArgs(args);
    const { cloudUrl, workspace, token } = await resolveDeploymentRequestContext(opts);
    const agent = opts.selector
      ? resolveAgentSelector(await fetchDeployments({ cloudUrl, workspace, token }), opts.selector)
      : null;

    if (opts.path) {
      const entries = await fetchLogEntries({
        cloudUrl,
        workspace,
        token,
        path: opts.path,
        ...(agent ? { agentId: agent.agentId } : {})
      });
      writeLogOutput(entries.slice(-opts.tail), opts);
      process.exit(0);
    }

    const paths = await fetchLogPaths({ cloudUrl, workspace, token });
    if (!agent) {
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ paths }, null, 2)}\n`);
      } else {
        process.stdout.write(paths.length ? `${paths.join('\n')}\n` : 'No workspace log files found.\n');
      }
      process.exit(0);
    }

    const entryFiles: LogEntry[][] = [];
    let collected = 0;
    for (const path of paths.slice(0, 14)) {
      const fileEntries = await fetchLogEntries({
        cloudUrl,
        workspace,
        token,
        path,
        agentId: agent.agentId
      });
      entryFiles.push(fileEntries);
      collected += fileEntries.length;
      if (collected >= opts.tail) break;
    }
    writeLogOutput(tailLogEntriesFromNewestFiles(entryFiles, opts.tail), opts);
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `\nagentworkforce logs failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}

export function parseDeploymentListArgs(args: readonly string[]): DeploymentListOptions {
  let workspace: string | undefined;
  let status: string | undefined;
  let persona: string | undefined;
  let json = false;
  let cloudUrl: string | undefined;
  let noPrompt = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--status') {
      status = expectValue('--status', args[++i]);
    } else if (arg.startsWith('--status=')) {
      status = expectInlineValue('--status', arg.slice('--status='.length));
    } else if (arg === '--persona') {
      persona = expectValue('--persona', args[++i]);
    } else if (arg.startsWith('--persona=')) {
      persona = expectInlineValue('--persona', arg.slice('--persona='.length));
    } else if (arg === '--workspace') {
      workspace = expectValue('--workspace', args[++i]);
    } else if (arg.startsWith('--workspace=')) {
      workspace = expectInlineValue('--workspace', arg.slice('--workspace='.length));
    } else if (arg === '--cloud-url') {
      cloudUrl = expectValue('--cloud-url', args[++i]);
    } else if (arg.startsWith('--cloud-url=')) {
      cloudUrl = expectInlineValue('--cloud-url', arg.slice('--cloud-url='.length));
    } else if (arg === '--no-prompt') {
      noPrompt = true;
    } else {
      throw new Error(`list: unexpected argument "${arg}"`);
    }
  }

  return {
    ...(workspace ? { workspace } : {}),
    ...(status ? { status } : {}),
    ...(persona ? { persona } : {}),
    ...(json ? { json: true } : {}),
    ...(cloudUrl ? { cloudUrl } : {}),
    ...(noPrompt ? { noPrompt: true } : {})
  };
}

export function parseDeploymentLogsArgs(args: readonly string[]): DeploymentLogsOptions {
  let selector: string | undefined;
  let workspace: string | undefined;
  let path: string | undefined;
  let tail = 50;
  let json = false;
  let cloudUrl: string | undefined;
  let noPrompt = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--workspace') {
      workspace = expectValue('--workspace', args[++i]);
    } else if (arg.startsWith('--workspace=')) {
      workspace = expectInlineValue('--workspace', arg.slice('--workspace='.length));
    } else if (arg === '--path') {
      path = expectValue('--path', args[++i]);
    } else if (arg.startsWith('--path=')) {
      path = expectInlineValue('--path', arg.slice('--path='.length));
    } else if (arg === '--tail') {
      tail = parseTail(expectValue('--tail', args[++i]));
    } else if (arg.startsWith('--tail=')) {
      tail = parseTail(expectInlineValue('--tail', arg.slice('--tail='.length)));
    } else if (arg === '--cloud-url') {
      cloudUrl = expectValue('--cloud-url', args[++i]);
    } else if (arg.startsWith('--cloud-url=')) {
      cloudUrl = expectInlineValue('--cloud-url', arg.slice('--cloud-url='.length));
    } else if (arg === '--no-prompt') {
      noPrompt = true;
    } else if (!arg.startsWith('-') && !selector) {
      selector = arg;
    } else {
      throw new Error(`logs: unexpected argument "${arg}"`);
    }
  }

  return {
    tail,
    ...(selector ? { selector } : {}),
    ...(workspace ? { workspace } : {}),
    ...(path ? { path } : {}),
    ...(json ? { json: true } : {}),
    ...(cloudUrl ? { cloudUrl } : {}),
    ...(noPrompt ? { noPrompt: true } : {})
  };
}

export function formatDeploymentsTable(agents: readonly DeploymentAgent[]): string {
  if (agents.length === 0) return 'No deployed agents found.\n';
  const rows = agents.map((agent) => ({
    name: deploymentDisplayName(agent),
    agentId: compactId(agent.agentId),
    status: agent.status,
    deployed: formatDate(agent.createdAt),
    lastUsed: agent.lastUsedAt ? formatRelative(agent.lastUsedAt) : '-'
  }));
  const widths = {
    name: Math.max('name'.length, ...rows.map((r) => r.name.length)),
    agentId: Math.max('agentId'.length, ...rows.map((r) => r.agentId.length)),
    status: Math.max('status'.length, ...rows.map((r) => r.status.length)),
    deployed: Math.max('deployed'.length, ...rows.map((r) => r.deployed.length)),
    lastUsed: Math.max('lastUsed'.length, ...rows.map((r) => r.lastUsed.length))
  };
  const header = [
    pad('name', widths.name),
    pad('status', widths.status),
    pad('deployed', widths.deployed),
    pad('lastUsed', widths.lastUsed),
    pad('agentId', widths.agentId)
  ].join('  ');
  const body = rows.map((row) => [
    pad(row.name, widths.name),
    pad(row.status, widths.status),
    pad(row.deployed, widths.deployed),
    pad(row.lastUsed, widths.lastUsed),
    pad(row.agentId, widths.agentId)
  ].join('  '));
  return `${[header, ...body].join('\n')}\n`;
}

export function formatDeploymentLogEntries(entries: readonly LogEntry[]): string {
  if (entries.length === 0) return 'No log entries found.\n';
  return entries.map(formatLogEntry).join('\n') + '\n';
}

export function tailLogEntriesFromNewestFiles(
  filesNewestFirst: readonly (readonly LogEntry[])[],
  tail: number
): LogEntry[] {
  const chronological: LogEntry[] = [];
  for (let i = filesNewestFirst.length - 1; i >= 0; i -= 1) {
    chronological.push(...filesNewestFirst[i]);
  }
  return chronological.slice(-tail);
}

function parseAgents(body: ListResponse): DeploymentAgent[] {
  const raw = Array.isArray(body) ? body : Array.isArray(body.agents) ? body.agents : [];
  return raw.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('list response contained an invalid agent entry');
    }
    const record = value as Record<string, unknown>;
    return {
      agentId: readString(record, 'agentId') ?? readString(record, 'id') ?? '',
      personaId: readString(record, 'personaId') ?? readString(record, 'persona') ?? '',
      personaSlug: readString(record, 'personaSlug') ?? readString(record, 'slug') ?? '',
      deployedName: readString(record, 'deployedName') ?? readString(record, 'name') ?? '',
      status: readString(record, 'status') ?? 'unknown',
      createdAt: readString(record, 'createdAt') ?? '',
      lastUsedAt: readNullableString(record, 'lastUsedAt'),
      scheduleIds: Array.isArray(record.scheduleIds)
        ? record.scheduleIds.filter((id): id is string => typeof id === 'string')
        : [],
      deployedByUserId: readString(record, 'deployedByUserId') ?? ''
    };
  }).filter((agent) => agent.agentId);
}

export async function resolveDeploymentRequestContext(opts: {
  workspace?: string;
  cloudUrl?: string;
  noPrompt?: boolean;
}): Promise<{ cloudUrl: string; workspace: string; token: string }> {
  const io = createTerminalIO();
  const cloudUrl = resolveCloudUrl({
    ...(opts.cloudUrl ? { flag: opts.cloudUrl } : {})
  });
  const auth = await resolveWorkspaceToken({
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
    cloudUrl,
    io,
    ...(opts.noPrompt ? { noPrompt: true } : {})
  });
  const workspace = auth.workspace?.trim() || opts.workspace?.trim();
  if (!workspace) {
    throw new Error('workspace is required: pass --workspace, set WORKFORCE_WORKSPACE_ID, or run `agentworkforce login`');
  }
  return { cloudUrl, workspace, token: auth.token };
}

export async function fetchDeployments(args: {
  cloudUrl: string;
  workspace: string;
  token: string;
}): Promise<DeploymentAgent[]> {
  const url = new URL(`${args.cloudUrl}/api/v1/workspaces/${encodeURIComponent(args.workspace)}/deployments`);
  return parseAgents(await requestJson<ListResponse>(url, args.token, 'deployment list'));
}

async function fetchLogPaths(args: {
  cloudUrl: string;
  workspace: string;
  token: string;
}): Promise<string[]> {
  const url = new URL(`${args.cloudUrl}/api/v1/workspaces/${encodeURIComponent(args.workspace)}/logs`);
  const body = await requestJson<LogsListResponse>(url, args.token, 'workspace logs');
  const items = Array.isArray(body.data?.items) ? body.data.items : [];
  return items
    .map(readLogPath)
    .filter((path): path is string => Boolean(path))
    .sort((a, b) => b.localeCompare(a));
}

async function fetchLogEntries(args: {
  cloudUrl: string;
  workspace: string;
  token: string;
  path: string;
  agentId?: string;
}): Promise<LogEntry[]> {
  const url = new URL(`${args.cloudUrl}/api/v1/workspaces/${encodeURIComponent(args.workspace)}/logs`);
  url.searchParams.set('path', args.path);
  if (args.agentId) url.searchParams.set('agentId', args.agentId);
  const body = await requestJson<LogsReadResponse>(url, args.token, 'workspace log file');
  const entries = Array.isArray(body.data?.entries) ? body.data.entries : [];
  return entries.filter((entry): entry is LogEntry => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
}

export async function requestJson<T>(url: URL, token: string, action: string): Promise<T> {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': 'agentworkforce-cli'
    }
  });
  if (res.status === 401) {
    throw new Error('unauthorized. Run `agentworkforce login` and retry.');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint = formatHttpErrorBody(body, { url: url.toString() });
    throw new Error(`${action} failed: ${res.status}${hint ? ` ${hint}` : ''}`);
  }
  return (await res.json()) as T;
}

export function resolveAgentSelector(agents: readonly DeploymentAgent[], selector: string): DeploymentAgent {
  const matches = agents.filter((agent) => {
    const candidates = [
      agent.agentId,
      compactId(agent.agentId),
      agent.deployedName,
      agent.personaSlug,
      agent.personaId
    ].filter(Boolean);
    return candidates.includes(selector);
  });
  if (matches.length === 0) {
    throw new Error(`no deployed agent matched "${selector}". Run \`agentworkforce deployments list\` to see names.`);
  }
  if (matches.length > 1) {
    throw new Error(`multiple deployed agents matched "${selector}". Use the agentId from \`agentworkforce deployments list\`.`);
  }
  return matches[0];
}

function deploymentDisplayName(agent: DeploymentAgent): string {
  return agent.deployedName || agent.personaSlug || agent.personaId || agent.agentId;
}

function writeLogOutput(entries: readonly LogEntry[], opts: DeploymentLogsOptions): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ entries }, null, 2)}\n`);
  } else {
    process.stdout.write(formatDeploymentLogEntries(entries));
  }
}

function readLogPath(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return readString(record, 'path') ?? readString(record, 'filePath') ?? readString(record, 'id');
}

function formatLogEntry(entry: LogEntry): string {
  const ts = readString(entry, 'ts') ?? readString(entry, 'timestamp') ?? '-';
  const level = (readString(entry, 'level') ?? 'info').toUpperCase();
  const agent = readString(entry, 'agentName') ?? readString(entry, 'agentId') ?? '-';
  const msg = readString(entry, 'msg') ?? readString(entry, 'message') ?? readString(entry, 'event') ?? JSON.stringify(entry);
  return `${ts}  ${level.padEnd(5)}  ${agent}  ${msg}`;
}

function compactId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 4)}...${id.slice(-4)}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function formatRelative(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function pad(value: string, width: number): string {
  return value.padEnd(width, ' ');
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseTail(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('--tail: expected a positive integer');
  }
  return parsed;
}

function expectValue(flag: string, value: string | undefined): string {
  if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) {
    throw new Error(`${flag}: missing value`);
  }
  return value;
}

function expectInlineValue(flag: string, value: string): string {
  if (!value.trim()) {
    throw new Error(`${flag}: missing value`);
  }
  return value;
}

const LIST_USAGE = `usage: agentworkforce list [flags]

List deployed cloud agents in the active workspace.

Flags:
  --workspace <name>          Workforce workspace; defaults to the logged-in workspace
  --status <status>           Filter by deployment status
  --persona <slug>            Filter by persona id/slug
  --json                      Emit JSON instead of a table
  --cloud-url <url>           Override the workforce cloud base URL
  --no-prompt                 Fail instead of prompting for cloud setup
  -h, --help                  Print this message
`;

const LOGS_USAGE = `usage: agentworkforce deployments logs [agent-name-or-id] [flags]

Read structured cloud logs for a deployed agent. Without an agent or --path,
prints available workspace log files.

Flags:
  --workspace <name>          Workforce workspace; defaults to the logged-in workspace
  --path <path>               Read a specific /_logs/... JSONL file
  --tail <n>                  Number of entries to print (default: 50)
  --json                      Emit JSON instead of text lines
  --cloud-url <url>           Override the workforce cloud base URL
  --no-prompt                 Fail instead of prompting for cloud setup
  -h, --help                  Print this message
`;
