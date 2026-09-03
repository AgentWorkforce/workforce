import {
  createTerminalIO,
  resolveCloudUrl,
  resolveWorkspaceToken,
  type DeployIO
} from '@agentworkforce/deploy';

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ENV_VALUE_BYTES = 64 * 1024;

export const ENV_USAGE = `usage: agentworkforce env <set|list|unset> [key] [flags]

Manage environment variables for the active workspace. Values are never
accepted as arguments: \`env set\` reads the value only from stdin.

Commands:
  env set <KEY>       Set or overwrite KEY from stdin
  env list            List names and audit metadata (never values)
  env unset <KEY>     Remove KEY; fails when KEY is not set

Flags:
  --workspace <name>  Workforce workspace; defaults to the active workspace
  --cloud-url <url>   Override the workforce cloud URL
  --json              Emit metadata as JSON (never values)
  --no-prompt         Fail instead of prompting for login

Examples:
  printf '%s' "$RTH_TOKEN" | agentworkforce env set RTH_TOKEN
  agentworkforce env list --workspace my-workspace
  agentworkforce env unset RTH_TOKEN
`;

type EnvAction = 'set' | 'list' | 'unset';

export type WorkspaceEnvOptions = {
  action: EnvAction;
  key?: string;
  workspace?: string;
  cloudUrl?: string;
  json: boolean;
  noPrompt: boolean;
};

export type WorkspaceEnvMetadata = {
  key: string;
  updatedAt: string;
  setBy: string;
};

type ReadableInput = AsyncIterable<string | Uint8Array> & { isTTY?: boolean };

type WorkspaceEnvDeps = {
  fetchImpl: typeof fetch;
  resolveWorkspaceToken: typeof resolveWorkspaceToken;
  resolveCloudUrl: typeof resolveCloudUrl;
  createTerminalIO: typeof createTerminalIO;
  stdin: ReadableInput;
  now: () => string;
};

const defaultDeps: WorkspaceEnvDeps = {
  fetchImpl: fetch,
  resolveWorkspaceToken,
  resolveCloudUrl,
  createTerminalIO,
  stdin: process.stdin,
  now: () => new Date().toISOString()
};

let envCommandDeps = defaultDeps;

export function configureEnvCommandForTest(
  overrides: Partial<WorkspaceEnvDeps>
): () => void {
  const previous = envCommandDeps;
  envCommandDeps = { ...envCommandDeps, ...overrides };
  return () => {
    envCommandDeps = previous;
  };
}

export function parseWorkspaceEnvArgs(args: readonly string[]): WorkspaceEnvOptions {
  const [rawAction, ...rest] = args;
  if (rawAction !== 'set' && rawAction !== 'list' && rawAction !== 'unset') {
    throw new Error('env: expected one of: set, list, unset');
  }

  let workspace: string | undefined;
  let cloudUrl: string | undefined;
  let json = false;
  let noPrompt = false;
  const positional: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === '--workspace') {
      workspace = expectFlagValue('--workspace', rest[++index]);
    } else if (arg.startsWith('--workspace=')) {
      workspace = expectInlineFlagValue('--workspace', arg.slice('--workspace='.length));
    } else if (arg === '--cloud-url') {
      cloudUrl = expectFlagValue('--cloud-url', rest[++index]);
    } else if (arg.startsWith('--cloud-url=')) {
      cloudUrl = expectInlineFlagValue('--cloud-url', arg.slice('--cloud-url='.length));
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--no-prompt') {
      noPrompt = true;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    } else {
      throw new Error(`env ${rawAction}: unsupported option; secret values must be passed only on stdin`);
    }
  }

  if (rawAction === 'list') {
    if (positional.length > 0) {
      throw new Error('env list: this command accepts no positional arguments');
    }
  } else if (positional.length === 0) {
    throw new Error(`env ${rawAction}: missing KEY`);
  } else if (positional.length > 1) {
    throw new Error(
      rawAction === 'set'
        ? 'env set: accepts only KEY; pass the value on stdin'
        : 'env unset: accepts only KEY'
    );
  }

  const key = positional[0];
  if (key !== undefined) validateWorkspaceEnvKey(key);

  return {
    action: rawAction,
    ...(key ? { key } : {}),
    ...(workspace ? { workspace } : {}),
    ...(cloudUrl ? { cloudUrl } : {}),
    json,
    noPrompt
  };
}

export function validateWorkspaceEnvKey(key: string): void {
  if (!ENV_KEY_PATTERN.test(key)) {
    throw new Error(
      'environment variable KEY must start with a letter or underscore, contain only letters, digits, and underscores, and be at most 128 characters'
    );
  }
}

export async function readWorkspaceEnvValue(input: ReadableInput): Promise<string> {
  if (input.isTTY) {
    throw new Error(
      'env set reads the value from non-interactive stdin; pipe it with printf or redirect a file'
    );
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_ENV_VALUE_BYTES) {
      throw new Error(`environment variable value exceeds ${MAX_ENV_VALUE_BYTES} bytes`);
    }
    chunks.push(buffer);
  }

  let value = Buffer.concat(chunks).toString('utf8');
  if (value.endsWith('\n')) {
    value = value.slice(0, -1);
    if (value.endsWith('\r')) value = value.slice(0, -1);
  }
  if (!value) throw new Error('environment variable value from stdin is empty');
  if (value.includes('\0')) throw new Error('environment variable value from stdin contains a NUL byte');
  return value;
}

export async function runEnv(args: readonly string[]): Promise<void> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    process.stdout.write(ENV_USAGE);
    return;
  }

  const options = parseWorkspaceEnvArgs(args);
  const io = envCommandDeps.createTerminalIO();
  const cloudUrl = envCommandDeps.resolveCloudUrl({
    ...(options.cloudUrl ? { flag: options.cloudUrl } : {})
  });
  const auth = await envCommandDeps.resolveWorkspaceToken({
    ...(options.workspace ? { workspace: options.workspace } : {}),
    cloudUrl,
    io,
    ...(options.noPrompt ? { noPrompt: true } : {})
  });
  // Cloud APIs are scoped by the canonical cloud workspace id. The relaycast
  // provider id exposed as `auth.workspace` may be numeric and is not the id
  // used by Relayfile-backed runtime storage.
  const workspace = auth.workspaceDescriptor?.cloudWorkspaceId?.trim()
    || auth.workspace?.trim()
    || options.workspace?.trim();
  if (!workspace) {
    throw new Error(
      'env: workspace is ambiguous; pass --workspace, set WORKFORCE_WORKSPACE_ID, or select an active workspace'
    );
  }

  if (options.action === 'set') {
    const value = await readWorkspaceEnvValue(envCommandDeps.stdin);
    const result = await setWorkspaceEnv({
      cloudUrl,
      workspace,
      token: auth.token,
      key: options.key!,
      value,
      fetchImpl: envCommandDeps.fetchImpl,
      now: envCommandDeps.now
    });
    writeSetOutput(io, result, options.json);
    return;
  }

  if (options.action === 'unset') {
    await unsetWorkspaceEnv({
      cloudUrl,
      workspace,
      token: auth.token,
      key: options.key!,
      fetchImpl: envCommandDeps.fetchImpl
    });
    writeUnsetOutput(io, { workspace, key: options.key! }, options.json);
    return;
  }

  const variables = await listWorkspaceEnv({
    cloudUrl,
    workspace,
    token: auth.token,
    fetchImpl: envCommandDeps.fetchImpl
  });
  writeListOutput(io, { workspace, variables }, options.json);
}

async function setWorkspaceEnv(input: {
  cloudUrl: string;
  workspace: string;
  token: string;
  key: string;
  value: string;
  fetchImpl: typeof fetch;
  now: () => string;
}): Promise<WorkspaceEnvMetadata & { workspace: string; overwritten: boolean }> {
  const detailUrl = workspaceEnvDetailUrl(input.cloudUrl, input.workspace, input.key);
  const existing = await input.fetchImpl(detailUrl, {
    method: 'GET',
    headers: authHeaders(input.token)
  });
  if (existing.status !== 404 && !existing.ok) {
    throw requestError('check', existing.status, input.workspace);
  }

  const response = await input.fetchImpl(workspaceEnvCollectionUrl(input.cloudUrl, input.workspace), {
    method: 'POST',
    headers: jsonAuthHeaders(input.token),
    body: JSON.stringify({
      name: input.key,
      envVar: input.key,
      kind: 'environment',
      value: input.value
    })
  });
  if (!response.ok) throw requestError('set', response.status, input.workspace);

  const record = await readJsonRecord(response);
  return {
    workspace: input.workspace,
    key: input.key,
    updatedAt: readString(record, 'updatedAt') ?? input.now(),
    setBy: readString(record, 'setBy') ?? 'unknown',
    overwritten: existing.ok
  };
}

async function listWorkspaceEnv(input: {
  cloudUrl: string;
  workspace: string;
  token: string;
  fetchImpl: typeof fetch;
}): Promise<WorkspaceEnvMetadata[]> {
  const response = await input.fetchImpl(workspaceEnvCollectionUrl(input.cloudUrl, input.workspace), {
    method: 'GET',
    headers: authHeaders(input.token)
  });
  if (!response.ok) throw requestError('list', response.status, input.workspace);

  const payload = await readJsonRecord(response);
  const data = isRecord(payload.data) ? payload.data : {};
  const items = Array.isArray(data.items) ? data.items : [];
  return items
    .map(toWorkspaceEnvMetadata)
    .filter((item): item is WorkspaceEnvMetadata => item !== null)
    .sort((left, right) => left.key.localeCompare(right.key));
}

async function unsetWorkspaceEnv(input: {
  cloudUrl: string;
  workspace: string;
  token: string;
  key: string;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const detailUrl = workspaceEnvDetailUrl(input.cloudUrl, input.workspace, input.key);
  const existing = await input.fetchImpl(detailUrl, {
    method: 'GET',
    headers: authHeaders(input.token)
  });
  if (existing.status === 404) throw missingWorkspaceEnvError(input.key, input.workspace);
  if (!existing.ok) throw requestError('check', existing.status, input.workspace);

  const existingRecord = await readJsonRecord(existing);
  const existingMetadata = toWorkspaceEnvMetadata(existingRecord);
  if (!existingMetadata || existingMetadata.key !== input.key) {
    throw missingWorkspaceEnvError(input.key, input.workspace);
  }

  const response = await input.fetchImpl(detailUrl, {
    method: 'DELETE',
    headers: authHeaders(input.token)
  });
  if (response.status === 404) throw missingWorkspaceEnvError(input.key, input.workspace);
  if (!response.ok) throw requestError('unset', response.status, input.workspace);
}

function toWorkspaceEnvMetadata(value: unknown): WorkspaceEnvMetadata | null {
  if (!isRecord(value)) return null;
  const name = readString(value, 'name');
  const envVar = readString(value, 'envVar');
  const kind = readString(value, 'kind');
  if (!envVar || kind !== 'environment' || name !== envVar) return null;
  if (!ENV_KEY_PATTERN.test(envVar)) return null;
  return {
    key: envVar,
    updatedAt: readString(value, 'updatedAt') ?? 'unknown',
    setBy: readString(value, 'setBy') ?? 'unknown'
  };
}

function writeSetOutput(
  io: DeployIO,
  result: WorkspaceEnvMetadata & { workspace: string; overwritten: boolean },
  json: boolean
): void {
  if (json) {
    io.info(JSON.stringify(result, null, 2));
    return;
  }
  io.info(
    `${result.overwritten ? 'Overwrote' : 'Set'} ${result.key} in workspace ${result.workspace}.`
  );
}

function writeUnsetOutput(
  io: DeployIO,
  result: { workspace: string; key: string },
  json: boolean
): void {
  if (json) {
    io.info(JSON.stringify({ ...result, unset: true }, null, 2));
    return;
  }
  io.info(`Unset ${result.key} in workspace ${result.workspace}.`);
}

function writeListOutput(
  io: DeployIO,
  result: { workspace: string; variables: WorkspaceEnvMetadata[] },
  json: boolean
): void {
  if (json) {
    io.info(JSON.stringify(result, null, 2));
    return;
  }
  if (result.variables.length === 0) {
    io.info(`No environment variables are set in workspace ${result.workspace}.`);
    return;
  }
  const widths = {
    key: Math.max('KEY'.length, ...result.variables.map((item) => item.key.length)),
    updatedAt: Math.max('LAST SET'.length, ...result.variables.map((item) => item.updatedAt.length))
  };
  const lines = [
    `${'KEY'.padEnd(widths.key)}  ${'LAST SET'.padEnd(widths.updatedAt)}  SET BY`,
    ...result.variables.map(
      (item) => `${item.key.padEnd(widths.key)}  ${item.updatedAt.padEnd(widths.updatedAt)}  ${item.setBy}`
    )
  ];
  io.info(lines.join('\n'));
}

function workspaceEnvCollectionUrl(cloudUrl: string, workspace: string): string {
  return `${cloudUrl.replace(/\/+$/, '')}/api/v1/workspaces/${encodeURIComponent(workspace)}/secrets`;
}

function workspaceEnvDetailUrl(cloudUrl: string, workspace: string, key: string): string {
  return `${workspaceEnvCollectionUrl(cloudUrl, workspace)}/${encodeURIComponent(key)}`;
}

function authHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'user-agent': 'agentworkforce-cli'
  };
}

function jsonAuthHeaders(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

function requestError(action: string, status: number, workspace: string): Error {
  if (status === 401) return new Error('env: unauthorized; run `agentworkforce login` and retry');
  if (status === 403) {
    return new Error(`env: active account cannot ${action} environment variables in workspace ${workspace}`);
  }
  return new Error(`env ${action} failed for workspace ${workspace} (HTTP ${status})`);
}

function missingWorkspaceEnvError(key: string, workspace: string): Error {
  return new Error(`env unset: ${key} is not set in workspace ${workspace}`);
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json().catch(() => null);
  if (!isRecord(value)) throw new Error('env: cloud returned an invalid response');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function expectFlagValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('-')) throw new Error(`env: ${flag} requires a value`);
  return value.trim();
}

function expectInlineFlagValue(flag: string, value: string): string {
  if (!value.trim()) throw new Error(`env: ${flag} requires a value`);
  return value.trim();
}
