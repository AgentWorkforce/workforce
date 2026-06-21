import { formatHttpErrorBody } from '@agentworkforce/deploy';
import {
  fetchDeployments,
  resolveAgentSelector,
  resolveDeploymentRequestContext
} from './list-command.js';

export const TRIGGER_USAGE = `usage: agentworkforce trigger <agent-name-or-id> [flags]
       agentworkforce deployments trigger <agent-name-or-id> [flags]

Manually fire an active deployed persona through the cloud trigger endpoint.
The selector may be an agent id, compact agent id, deployed name, persona slug,
or persona id. Use this to force a fresh run for testing without waiting for
the persona's normal schedule or integration event.

Flags:
  --workspace <name>          Workforce workspace; defaults to the active one.
  --cloud-url <url>           Override the workforce cloud base URL.
  --json                      Emit the trigger response JSON.
  --no-prompt                 Fail instead of prompting for login.
  -h, --help                  Print this message.
`;

export interface TriggerOptions {
  selector: string;
  workspace?: string;
  cloudUrl?: string;
  json?: boolean;
  noPrompt?: boolean;
}

export type ParsedTriggerArgs = TriggerOptions | { help: true };

export interface TriggerResponse {
  agentId: string;
  workspaceId: string;
  deploymentId: string;
  status: string;
}

export interface TriggerIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIO: TriggerIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
};

export function parseTriggerArgs(args: readonly string[]): ParsedTriggerArgs {
  let selector: string | undefined;
  let workspace: string | undefined;
  let cloudUrl: string | undefined;
  let json = false;
  let noPrompt = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    } else if (arg === '--workspace') {
      workspace = expectValue('--workspace', args[++i]);
    } else if (arg.startsWith('--workspace=')) {
      workspace = expectInlineValue('--workspace', arg.slice('--workspace='.length));
    } else if (arg === '--cloud-url') {
      cloudUrl = expectValue('--cloud-url', args[++i]);
    } else if (arg.startsWith('--cloud-url=')) {
      cloudUrl = expectInlineValue('--cloud-url', arg.slice('--cloud-url='.length));
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--no-prompt') {
      noPrompt = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`trigger: unknown flag "${arg}"`);
    } else if (!arg.startsWith('-') && !selector) {
      selector = arg;
    } else if (arg.startsWith('-')) {
      throw new Error(`trigger: unknown flag "${arg}"`);
    } else {
      throw new Error(`trigger: unexpected positional argument "${arg}"`);
    }
  }

  if (!selector) {
    throw new Error('trigger: missing agent selector. Usage: agentworkforce trigger <agent-name-or-id>');
  }

  return {
    selector,
    ...(workspace ? { workspace } : {}),
    ...(cloudUrl ? { cloudUrl } : {}),
    ...(json ? { json: true } : {}),
    ...(noPrompt ? { noPrompt: true } : {})
  };
}

export async function runTrigger(
  args: readonly string[],
  io: TriggerIO = defaultIO
): Promise<void> {
  let opts: ParsedTriggerArgs;
  try {
    opts = parseTriggerArgs(args);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n\n${TRIGGER_USAGE}`);
    process.exitCode = 1;
    return;
  }
  if ('help' in opts) {
    io.stdout(TRIGGER_USAGE);
    return;
  }

  try {
    const result = await triggerDeployment(opts);
    if (opts.json) {
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      io.stdout(formatTriggerResult(result));
    }
    process.exitCode = 0;
  } catch (err) {
    io.stderr(`trigger: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

export async function triggerDeployment(opts: TriggerOptions): Promise<TriggerResponse> {
  const ctx = await resolveDeploymentRequestContext({
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
    ...(opts.cloudUrl ? { cloudUrl: opts.cloudUrl } : {}),
    ...(opts.noPrompt ? { noPrompt: true } : {})
  });

  const agents = await fetchDeployments({
    cloudUrl: ctx.cloudUrl,
    workspace: ctx.workspace,
    token: ctx.token
  });
  const agent = resolveAgentSelector(agents, opts.selector);
  const url = buildTriggerUrl({
    cloudUrl: ctx.cloudUrl,
    workspace: ctx.workspace,
    agentId: agent.agentId
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ctx.token}`,
      'user-agent': 'agentworkforce-cli/trigger'
    }
  });
  if (res.status === 401) {
    throw new Error('unauthorized. Run `agentworkforce login` and retry.');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint = formatHttpErrorBody(body, { url: url.toString() });
    throw new Error(`manual trigger failed: ${res.status}${hint ? ` ${hint}` : ''}`);
  }

  return parseTriggerResponse(await res.json(), opts.selector);
}

export function formatTriggerResult(result: TriggerResponse): string {
  return (
    `triggered: ${result.agentId}\n` +
    `deployment: ${result.deploymentId}\n` +
    `workspace: ${result.workspaceId}\n` +
    `status: ${result.status}\n`
  );
}

export function parseTriggerResponse(value: unknown, selector: string): TriggerResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`manual trigger for "${selector}" returned an invalid response`);
  }
  const record = value as Record<string, unknown>;
  const agentId = readString(record, 'agentId');
  const workspaceId = readString(record, 'workspaceId');
  const deploymentId = readString(record, 'deploymentId');
  const status = readString(record, 'status');
  if (!agentId || !workspaceId || !deploymentId || !status) {
    throw new Error(`manual trigger for "${selector}" returned an incomplete response`);
  }
  return { agentId, workspaceId, deploymentId, status };
}

export function buildTriggerUrl(input: {
  cloudUrl: string;
  workspace: string;
  agentId: string;
}): URL {
  return new URL(
    `${trimTrailingSlash(input.cloudUrl)}/api/v1/workspaces/${encodeURIComponent(input.workspace)}` +
      `/deployments/${encodeURIComponent(input.agentId)}/trigger`
  );
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function expectValue(flag: string, value: string | undefined): string {
  if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) {
    throw new Error(`trigger: ${flag} expects a value`);
  }
  return value;
}

function expectInlineValue(flag: string, value: string): string {
  if (!value.trim()) {
    throw new Error(`trigger: ${flag} expects a value`);
  }
  return value;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
