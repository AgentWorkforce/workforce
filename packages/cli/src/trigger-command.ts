import { readFile } from 'node:fs/promises';
import { formatHttpErrorBody } from '@agentworkforce/deploy';
import {
  fetchDeployments,
  resolveAgentSelector,
  resolveDeploymentRequestContext
} from './list-command.js';

export const TRIGGER_USAGE = `usage: agentworkforce trigger <agent-name-or-id> [payload-json] [flags]
       agentworkforce deployments trigger <agent-name-or-id> [payload-json] [flags]

Manually fire an active deployed persona through the cloud trigger endpoint.
The selector may be an agent id, compact agent id, deployed name, persona slug,
or persona id. Use this to force a fresh run for testing without waiting for
the persona's normal schedule or integration event.

A payload is optional. With one, this is the same call a product makes to wake
an agent with data: the JSON object reaches the handler as the event payload.
Without one the agent gets a contentless fire, which is what a schedule looks
like — so an agent whose real work is payload-driven cannot be exercised by a
bare trigger.

Examples:
  agentworkforce trigger app-signal '{"accountId":"acme","reason":"usage_spike"}'
  agentworkforce trigger app-signal --payload-file ./signal.json
  echo '{"accountId":"acme"}' | agentworkforce trigger app-signal --payload-file -

Flags:
  --payload <json>            JSON object to send as the event payload.
  --payload-file <path>       Read the payload JSON from a file, or "-" for stdin.
  --idempotency-key <key>     Retrying with the same key returns the original run
                              instead of starting a second one.
  --workspace <name>          Workforce workspace; defaults to the active one.
  --cloud-url <url>           Override the workforce cloud base URL.
  --json                      Emit the trigger response JSON.
  --no-prompt                 Fail instead of prompting for login.
  -h, --help                  Print this message.
`;

export interface TriggerOptions {
  selector: string;
  /**
   * Parsed JSON object sent as the request body. Absent means a contentless
   * fire — the endpoint treats a body-less POST and a `{}` body differently,
   * so this stays undefined rather than defaulting to an empty object.
   */
  payload?: Record<string, unknown>;
  /** Sent as `Idempotency-Key`; a repeat returns the original run. */
  idempotencyKey?: string;
  workspace?: string;
  cloudUrl?: string;
  json?: boolean;
  noPrompt?: boolean;
}

/** Where the payload comes from, before any I/O has happened. */
export interface PayloadSource {
  kind: 'inline' | 'file';
  value: string;
}

/**
 * Argument parsing stays synchronous and side-effect free, so it can be tested
 * without a filesystem or stdin. Reading `--payload-file` is deferred to
 * {@link resolvePayload}, which `runTrigger` calls before dispatching.
 */
export interface TriggerArgs extends Omit<TriggerOptions, 'payload'> {
  payloadSource?: PayloadSource;
}

export type ParsedTriggerArgs = TriggerArgs | { help: true };

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
  let payloadSource: { kind: 'inline' | 'file'; value: string } | undefined;
  let idempotencyKey: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    } else if (arg === '--payload') {
      payloadSource = { kind: 'inline', value: expectValue('--payload', args[++i]) };
    } else if (arg.startsWith('--payload=')) {
      payloadSource = {
        kind: 'inline',
        value: expectInlineValue('--payload', arg.slice('--payload='.length))
      };
    } else if (arg === '--payload-file') {
      payloadSource = { kind: 'file', value: expectPathValue('--payload-file', args[++i]) };
    } else if (arg.startsWith('--payload-file=')) {
      payloadSource = {
        kind: 'file',
        value: expectInlineValue('--payload-file', arg.slice('--payload-file='.length))
      };
    } else if (arg === '--idempotency-key') {
      idempotencyKey = expectValue('--idempotency-key', args[++i]);
    } else if (arg.startsWith('--idempotency-key=')) {
      idempotencyKey = expectInlineValue(
        '--idempotency-key',
        arg.slice('--idempotency-key='.length)
      );
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
    } else if (arg.trimStart().startsWith('{') && !payloadSource) {
      // A trailing `{...}` is the payload. Unambiguous against a selector: an
      // agent id, deployed name, persona slug and persona id can none of them
      // start with a brace.
      payloadSource = { kind: 'inline', value: arg };
    } else {
      throw new Error(`trigger: unexpected positional argument "${arg}"`);
    }
  }

  if (!selector) {
    throw new Error('trigger: missing agent selector. Usage: agentworkforce trigger <agent-name-or-id>');
  }

  return {
    selector,
    ...(payloadSource ? { payloadSource } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
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
    const payload = await resolvePayload(opts.payloadSource, io);
    const { payloadSource: _ignored, ...rest } = opts;
    const result = await triggerDeployment({
      ...rest,
      ...(payload ? { payload } : {})
    });
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

  const res = await fetch(url, buildTriggerRequest(opts, ctx.token));
  if (res.status === 401) {
    throw new Error('unauthorized. Run `agentworkforce login` and retry.');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint = formatHttpErrorBody(body, { url: url.toString() });
    const authHint = res.status === 403 ? ` ${formatTriggerAuthHint(ctx)}` : '';
    throw new Error(`manual trigger failed: ${res.status}${hint ? ` ${hint}` : ''}${authHint}`);
  }

  return parseTriggerResponse(await res.json(), opts.selector);
}

/**
 * Turn `--payload` / `--payload-file` into the object to send, or undefined for
 * a contentless fire.
 *
 * The payload must be a JSON **object**: cloud wraps the body as
 * `{ source: 'app.trigger', payload: <body> }` and handlers read named fields
 * off it, so an array or a bare scalar would arrive as something no handler can
 * use. Rejecting it here beats a 202 followed by a run that silently does
 * nothing.
 */
export async function resolvePayload(
  source: PayloadSource | undefined,
  io: TriggerIO
): Promise<Record<string, unknown> | undefined> {
  if (!source) return undefined;

  const raw =
    source.kind === 'inline'
      ? source.value
      : source.value === '-'
        ? await readStdin(io)
        : await readFile(source.value, 'utf8').catch((err: unknown) => {
            throw new Error(
              `could not read payload file "${source.value}": ${err instanceof Error ? err.message : String(err)}`
            );
          });

  const label = source.kind === 'file' ? `payload file "${source.value}"` : 'payload';
  if (!raw.trim()) {
    throw new Error(`${label} is empty. Omit it entirely to send a contentless fire.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `${label} must be a JSON object (got ${Array.isArray(parsed) ? 'an array' : typeof parsed}). ` +
        'The handler receives it as the event payload and reads named fields off it.'
    );
  }
  return parsed as Record<string, unknown>;
}

async function readStdin(io: TriggerIO): Promise<string> {
  if (process.stdin.isTTY) {
    io.stderr('trigger: reading payload from stdin; end with Ctrl-D\n');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Build the POST for the trigger endpoint.
 *
 * A body-less POST and a `{}` body are NOT the same thing to cloud: the first
 * is a contentless fire (indistinguishable from a schedule firing), the second
 * is an app trigger carrying an empty object. So Content-Type and body are
 * attached only when there is a payload, never defaulted.
 */
export function buildTriggerRequest(
  opts: Pick<TriggerOptions, 'payload' | 'idempotencyKey'>,
  token: string
): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': 'agentworkforce-cli/trigger',
      ...(opts.payload ? { 'content-type': 'application/json' } : {}),
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {})
    },
    ...(opts.payload ? { body: JSON.stringify(opts.payload) } : {})
  };
}

export function formatTriggerAuthHint(ctx: {
  authSource?: 'env' | 'cloud-session';
  workspace: string;
}): string {
  if (ctx.authSource === 'env') {
    return (
      `Auth source: WORKFORCE_WORKSPACE_TOKEN for workspace ${ctx.workspace}. ` +
      'If this token is stale or lacks trigger scope, unset WORKFORCE_WORKSPACE_TOKEN and WORKFORCE_WORKSPACE_ID, then run `agentworkforce login`.'
    );
  }
  if (ctx.authSource === 'cloud-session') {
    return (
      `Auth source: Agent Relay cloud session for workspace ${ctx.workspace}. ` +
      'Run `agentworkforce login` to refresh the session, or confirm this account has workspace access.'
    );
  }
  return (
    `Auth source: unknown for workspace ${ctx.workspace}. ` +
    'Run `agentworkforce login`, or set WORKFORCE_WORKSPACE_ID and WORKFORCE_WORKSPACE_TOKEN explicitly.'
  );
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

/**
 * Like {@link expectValue} but allows a leading "-", so `--payload-file -`
 * (stdin) is not mistaken for a missing value.
 */
function expectPathValue(flag: string, value: string | undefined): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`trigger: ${flag} expects a value`);
  }
  if (value !== '-' && value.startsWith('-')) {
    throw new Error(`trigger: ${flag} expects a value`);
  }
  return value;
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
