import {
  createTerminalIO,
  resolveWorkspaceToken
} from '@agentworkforce/deploy';

const DEFAULT_CLOUD_URL = 'https://agentrelay.com';

type DeploymentListOptions = {
  workspace?: string;
  status?: string;
  persona?: string;
  json?: boolean;
  cloudUrl?: string;
  noPrompt?: boolean;
};

type DeploymentAgent = {
  agentId: string;
  personaId: string;
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

export async function runDeploymentList(args: readonly string[]): Promise<void> {
  if (args.length > 0 && (args[0] === '-h' || args[0] === '--help')) {
    process.stdout.write(LIST_USAGE);
    process.exit(0);
  }

  try {
    const opts = parseDeploymentListArgs(args);
    const io = createTerminalIO();
    const cloudUrl = normalizeCloudUrl(
      opts.cloudUrl
        ?? process.env.WORKFORCE_DEPLOY_CLOUD_URL
        ?? process.env.WORKFORCE_CLOUD_URL
        ?? DEFAULT_CLOUD_URL
    );
    const auth = await resolveWorkspaceToken({
      workspace: opts.workspace,
      cloudUrl,
      io,
      noPrompt: opts.noPrompt
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
      throw new Error(`list failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
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

export function formatDeploymentsTable(agents: readonly DeploymentAgent[]): string {
  if (agents.length === 0) return 'No deployed agents found.\n';
  const rows = agents.map((agent) => ({
    agentId: compactId(agent.agentId),
    persona: agent.personaId || agent.deployedName,
    status: agent.status,
    deployed: formatDate(agent.createdAt),
    lastUsed: agent.lastUsedAt ? formatRelative(agent.lastUsedAt) : '-'
  }));
  const widths = {
    agentId: Math.max('agentId'.length, ...rows.map((r) => r.agentId.length)),
    persona: Math.max('persona'.length, ...rows.map((r) => r.persona.length)),
    status: Math.max('status'.length, ...rows.map((r) => r.status.length)),
    deployed: Math.max('deployed'.length, ...rows.map((r) => r.deployed.length)),
    lastUsed: Math.max('lastUsed'.length, ...rows.map((r) => r.lastUsed.length))
  };
  const header = [
    pad('agentId', widths.agentId),
    pad('persona', widths.persona),
    pad('status', widths.status),
    pad('deployed', widths.deployed),
    pad('lastUsed', widths.lastUsed)
  ].join('  ');
  const body = rows.map((row) => [
    pad(row.agentId, widths.agentId),
    pad(row.persona, widths.persona),
    pad(row.status, widths.status),
    pad(row.deployed, widths.deployed),
    pad(row.lastUsed, widths.lastUsed)
  ].join('  '));
  return `${[header, ...body].join('\n')}\n`;
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

function normalizeCloudUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : DEFAULT_CLOUD_URL;
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
