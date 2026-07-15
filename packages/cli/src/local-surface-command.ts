import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawn as spawnChild } from 'node:child_process';
import {
  enrollFleetNode,
  resolveActiveFleetNodeEnrollment,
  upsertFleetNodeEnrollment,
  type FleetNodeEnrollmentRecord
} from '@agent-relay/cloud';
import {
  createTerminalIO,
  formatHttpErrorBody,
  preflightPersona,
  resolveCloudUrl,
  resolveWorkspaceToken
} from '@agentworkforce/deploy';
import { fetchDeployments, type DeploymentAgent } from './list-command.js';

export const LOCAL_SURFACE_USAGE = `usage: agentworkforce local-surface <persona-path> [flags]

Run a proactive persona on this machine, triggered by real provider webhooks
routed through the fleet/relaycast infrastructure — no public IP, tunnel, or
manual token wiring required. The persona runs in \`--mode dev\`; local
credential mirroring is NOT supported (workforce#local-surface-plan), so this
is safe for cron/timer-only or webhook-shape-only personas that don't need a
per-connection integration credential resolved locally.

Requires a prior cloud deployment: this command resolves the persona's cloud
DB id from its deployed \`agents\` row (\`agentworkforce deploy ... --mode
cloud\`) and fails loudly if none exists — both because Cloud only fans
local-surface events out to a persona with an ACTIVE deployment that has real
watch config (declared triggers), and because there is no other way for this
command to identify the persona to Cloud. It can't detect a
deployed-with-no-watch-config persona from the workforce side (that data
isn't exposed to the CLI); if events never arrive despite a successful setup,
check that the persona's declared triggers match the event you're expecting.

Flags:
  --workspace <id>          Workforce workspace to opt in. Defaults to the
                             active workspace (same resolution as \`deploy\`).
  --enrollment-token <tok>  One-time Cloud fleet-node enrollment token
                             (ocl_node_enr_...), from the Cloud dashboard's
                             "Enroll node" action. Only needed the first time
                             on this machine — the resulting node credentials
                             are persisted and reused on subsequent runs.
  --enrollment-url <url>    Enrollment redeem endpoint. Defaults to
                             <cloud-url>/api/v1/fleet/register.
  --node-name <name>        Fleet node name. Defaults to a channel-derived name.
  --config-out <file>       Where to write the generated node-config file.
                             Defaults to
                             ~/.agentworkforce/local-surface/<persona-id>.mjs
  --cloud-url <url>         Override WORKFORCE_CLOUD_URL.
  --json                    Print machine-readable setup info instead of
                             shelling out to \`relay node up\` (useful for
                             scripting / tests).
  -h, --help                Print this message.
`;

export interface LocalSurfaceOptions {
  personaPath: string;
  workspace?: string;
  enrollmentToken?: string;
  enrollmentUrl?: string;
  nodeName?: string;
  configOut?: string;
  cloudUrl?: string;
  json?: boolean;
}

export type ParsedLocalSurfaceArgs = LocalSurfaceOptions | { help: true };

export function parseLocalSurfaceArgs(args: readonly string[]): ParsedLocalSurfaceArgs {
  let personaPath: string | undefined;
  const opts: LocalSurfaceOptions = { personaPath: '' };

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      return { help: true };
    } else if (a === '--workspace') {
      opts.workspace = expectValue('--workspace', args[++i]);
    } else if (a === '--enrollment-token') {
      opts.enrollmentToken = expectValue('--enrollment-token', args[++i]);
    } else if (a === '--enrollment-url') {
      opts.enrollmentUrl = expectValue('--enrollment-url', args[++i]);
    } else if (a === '--node-name') {
      opts.nodeName = expectValue('--node-name', args[++i]);
    } else if (a === '--config-out') {
      opts.configOut = expectValue('--config-out', args[++i]);
    } else if (a === '--cloud-url') {
      opts.cloudUrl = expectValue('--cloud-url', args[++i]);
    } else if (a === '--json') {
      opts.json = true;
    } else if (a.startsWith('--')) {
      throw new Error(`local-surface: unknown flag "${a}"`);
    } else if (!personaPath) {
      personaPath = a;
    } else {
      throw new Error(`local-surface: unexpected positional argument "${a}"`);
    }
  }

  if (!personaPath) {
    throw new Error('local-surface: missing persona path. Usage: agentworkforce local-surface <persona-path>');
  }
  return { ...opts, personaPath: path.resolve(personaPath) };
}

function expectValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`local-surface: ${flag} expects a value`);
  }
  return value;
}

export interface LocalSurfaceApiResponse {
  channel: string;
  relayWorkspaceId?: string;
}

export interface LocalSurfaceCommandDeps {
  resolveWorkspaceToken: typeof resolveWorkspaceToken;
  resolveActiveFleetNodeEnrollment: typeof resolveActiveFleetNodeEnrollment;
  enrollFleetNode: typeof enrollFleetNode;
  upsertFleetNodeEnrollment: typeof upsertFleetNodeEnrollment;
  preflightPersona: typeof preflightPersona;
  fetchDeployments: typeof fetchDeployments;
  fetch: typeof fetch;
  spawn: typeof spawnChild;
  writeFile: typeof writeFile;
  mkdir: typeof mkdir;
  resolveLocalSurfaceEntry(): string;
  now(): Date;
  log(message: string): void;
  error(message: string): void;
}

function defaultResolveLocalSurfaceEntry(): string {
  return createRequire(import.meta.url).resolve('@agentworkforce/local-surface');
}

const defaultDeps: LocalSurfaceCommandDeps = {
  resolveWorkspaceToken,
  resolveActiveFleetNodeEnrollment,
  enrollFleetNode,
  upsertFleetNodeEnrollment,
  preflightPersona,
  fetchDeployments,
  fetch,
  spawn: spawnChild,
  writeFile,
  mkdir,
  resolveLocalSurfaceEntry: defaultResolveLocalSurfaceEntry,
  now: () => new Date(),
  log: (message) => process.stdout.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`)
};

let deps = defaultDeps;

export function configureLocalSurfaceCommandForTest(overrides: Partial<LocalSurfaceCommandDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...overrides };
  return () => {
    deps = previous;
  };
}

/**
 * `agentworkforce local-surface <persona-path>` entry.
 *
 * 1. Resolve workspace + token via the same flow `deploy` already uses.
 * 2. Resolve the persona's cloud-side DB UUID from its deployed `agents` row
 *    (`resolveDeployedPersonaUuid`) — fails loudly if none exists. This is a
 *    hard requirement, not just a courtesy check: it's the only way to learn
 *    the UUID `POST /api/v1/fleet/local-surface` needs, and Cloud's
 *    dispatch-time relevance filter only fans events out to a persona's
 *    deployed `agents` row (real watch config) in the first place — opting
 *    into local-surface alone is never sufficient (cloud#2623, dfd446511).
 * 3. Reuse a persisted fleet-node enrollment, or redeem `--enrollment-token`
 *    (minting one requires a browser session — `POST
 *    /api/v1/fleet/enrollment-tokens` is session-cookie-gated, so a headless
 *    CLI can only redeem an already-minted token, via the same
 *    `enrollFleetNode`/`upsertFleetNodeEnrollment` store `relay cloud enroll`
 *    and `relay node up` already read/write).
 * 4. Call `POST /api/v1/fleet/local-surface` to opt the persona in and get
 *    back its bound relaycast channel (session OR `cli:auth`/deploy-scoped
 *    bearer token — `resolveWorkspaceToken()`'s token qualifies).
 * 5. Write a node-config file that default-exports
 *    `defineWorkforcePersonaNode(...)`.
 * 6. Shell out to `relay node up --config <file>`.
 *
 * Sets `process.exitCode` (never calls `process.exit`) so tests can call
 * this directly.
 */
export async function runLocalSurface(args: readonly string[]): Promise<void> {
  let parsed: ParsedLocalSurfaceArgs;
  try {
    parsed = parseLocalSurfaceArgs(args);
  } catch (err) {
    deps.error(`${err instanceof Error ? err.message : String(err)}\n\n${LOCAL_SURFACE_USAGE}`);
    process.exitCode = 1;
    return;
  }
  if ('help' in parsed) {
    deps.log(LOCAL_SURFACE_USAGE);
    return;
  }

  try {
    await runLocalSurfaceWithOptions(parsed);
  } catch (err) {
    deps.error(`local-surface: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

async function runLocalSurfaceWithOptions(opts: LocalSurfaceOptions): Promise<void> {
  const io = createTerminalIO();
  const cloudUrl = resolveCloudUrl(opts.cloudUrl ? { flag: opts.cloudUrl } : {});

  const preflight = await deps.preflightPersona(opts.personaPath);
  for (const warning of preflight.warnings) {
    deps.error(`warn: ${warning}`);
  }
  if (Object.keys(preflight.persona.integrations ?? {}).length > 0) {
    deps.error(
      `warn: persona "${preflight.persona.id}" declares integrations — local-surface does not mirror ` +
        'per-connection credentials locally (known gap); any integration-touching action will fail. ' +
        'Cron/timer-only and webhook-shape-only personas are the safe target for this mode today.'
    );
  }

  const auth = await deps.resolveWorkspaceToken({
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
    cloudUrl,
    io
  });
  const workspace = (auth.workspace ?? opts.workspace ?? '').trim();
  if (!workspace) {
    throw new Error('workspace is required: pass --workspace or run `agentworkforce login`');
  }
  const token = auth.token.trim();
  if (!token) {
    throw new Error('workspace token is required: run `agentworkforce login`');
  }
  deps.log(`local-surface: workspace ${workspace}`);

  const personaUuid = await resolveDeployedPersonaUuid({
    cloudUrl,
    workspace,
    token,
    personaSlug: preflight.persona.id
  });

  const enrollment = await resolveOrRedeemEnrollment({ workspace, opts, cloudUrl });
  deps.log(`local-surface: fleet node "${enrollment.nodeName}" (${enrollment.relaycastUrl})`);

  const localSurface = await callLocalSurfaceApi({ cloudUrl, token, workspace, personaId: personaUuid });
  deps.log(`local-surface: channel "${localSurface.channel}"`);

  const configPath = opts.configOut
    ? path.resolve(opts.configOut)
    : defaultConfigPath(preflight.persona.id);
  await writeNodeConfig({
    configPath,
    personaPath: preflight.personaPath,
    channel: localSurface.channel,
    workspace,
    workspaceToken: token,
    cloudUrl,
    nodeName: opts.nodeName
  });
  deps.log(`local-surface: wrote node config to ${configPath}`);

  if (opts.json) {
    deps.log(
      JSON.stringify(
        {
          workspace,
          channel: localSurface.channel,
          nodeName: enrollment.nodeName,
          configPath
        },
        null,
        2
      )
    );
    return;
  }

  await runRelayNodeUp(configPath, opts.nodeName);
}

/**
 * Resolve the persona's cloud-side DB UUID from its deployed `agents` row —
 * this is a hard requirement, not just a UX nicety: `POST
 * /api/v1/fleet/local-surface`'s `personaId` field is `personas.id` (a
 * UUID), NOT the workforce persona.json's own `id` (a human slug). Sending
 * the slug would 404/500 at the API call regardless, so there is no valid
 * request to make until the persona has been `agentworkforce deploy`ed to
 * this workspace at least once — which is also exactly the condition Cloud's
 * dispatch-time relevance filter needs (a deployed `agents` row with real
 * watch config; cloud#2623, dfd446511) for events to ever arrive. Mirrors
 * `modes/cloud/index.ts`'s `findExistingAgent`/`parseAgentLike` matching
 * (there is no server-side `?personaId=<slug>` filter — `agents.personaId`
 * is a UUID, so the workspace's deployments list is fetched and matched
 * client-side against `deployedName`/`personaSlug`/`personaId`) and
 * `parseExistingAgent`'s active-first, newest-first tiebreak.
 */
async function resolveDeployedPersonaUuid(input: {
  cloudUrl: string;
  workspace: string;
  token: string;
  personaSlug: string;
}): Promise<string> {
  const deployments = await deps.fetchDeployments({
    cloudUrl: input.cloudUrl,
    workspace: input.workspace,
    token: input.token
  });
  const matches = deployments.filter(
    (agent) =>
      agent.status !== 'destroyed' &&
      (agent.deployedName === input.personaSlug ||
        agent.personaSlug === input.personaSlug ||
        agent.personaId === input.personaSlug)
  );
  if (matches.length === 0) {
    throw new Error(
      `persona "${input.personaSlug}" has no active cloud-side deployment in workspace ${input.workspace}. ` +
        "Cloud only routes local-surface events to a persona's deployed `agents` row (real watch config from " +
        '`agentworkforce deploy`) — opting into local-surface requires the persona to already be deployed there. ' +
        `Run: agentworkforce deploy ${input.personaSlug} --mode cloud --workspace ${input.workspace} — then re-run.`
    );
  }
  matches.sort((a, b) => {
    const aActive = a.status === 'active' ? 1 : 0;
    const bActive = b.status === 'active' ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return Date.parse(b.createdAt || '') - Date.parse(a.createdAt || '');
  });
  const personaUuid = matches[0]!.personaId.trim();
  if (!personaUuid) {
    throw new Error(
      `matched a deployment for persona "${input.personaSlug}" but its personaId field was empty — ` +
        'cannot resolve the persona to opt into local-surface.'
    );
  }
  return personaUuid;
}

async function resolveOrRedeemEnrollment(input: {
  workspace: string;
  opts: LocalSurfaceOptions;
  cloudUrl: string;
}): Promise<FleetNodeEnrollmentRecord> {
  const existing = deps.resolveActiveFleetNodeEnrollment({ workspaceId: input.workspace });
  if (existing) {
    return existing;
  }

  const enrollmentToken = input.opts.enrollmentToken?.trim();
  if (!enrollmentToken) {
    throw new Error(
      `no fleet node enrollment found for workspace ${input.workspace}. Get a one-time enrollment token from ` +
        'the Cloud dashboard ("Enroll node") and re-run with --enrollment-token <token> ' +
        '(pass --enrollment-url too if it differs from <cloud-url>/api/v1/fleet/register).'
    );
  }
  const enrollmentUrl =
    input.opts.enrollmentUrl?.trim() || `${input.cloudUrl.replace(/\/+$/, '')}/api/v1/fleet/register`;
  const enrolled = await deps.enrollFleetNode({
    enrollmentToken,
    enrollmentUrl,
    ...(input.opts.nodeName ? { name: input.opts.nodeName } : {})
  });
  const record: FleetNodeEnrollmentRecord = { ...enrolled, enrolledAt: deps.now().toISOString() };
  deps.upsertFleetNodeEnrollment(record);
  return record;
}

async function callLocalSurfaceApi(input: {
  cloudUrl: string;
  token: string;
  workspace: string;
  personaId: string;
}): Promise<LocalSurfaceApiResponse> {
  const url = `${input.cloudUrl.replace(/\/+$/, '')}/api/v1/fleet/local-surface`;
  const response = await deps.fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.token}`,
      'content-type': 'application/json',
      'user-agent': 'workforce-local-surface'
    },
    body: JSON.stringify({ workspaceId: input.workspace, personaId: input.personaId })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `POST /api/v1/fleet/local-surface failed: ${response.status} ${formatHttpErrorBody(text, { url })}`.trim()
    );
  }
  const body = (await response.json().catch(() => null)) as Partial<LocalSurfaceApiResponse> | null;
  const channel = body?.channel?.trim();
  if (!channel) {
    throw new Error('POST /api/v1/fleet/local-surface response is missing "channel"');
  }
  return { channel, ...(body?.relayWorkspaceId ? { relayWorkspaceId: body.relayWorkspaceId } : {}) };
}

function defaultConfigPath(personaId: string): string {
  return path.join(os.homedir(), '.agentworkforce', 'local-surface', `${sanitizeFileName(personaId)}.mjs`);
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

async function writeNodeConfig(input: {
  configPath: string;
  personaPath: string;
  channel: string;
  workspace: string;
  workspaceToken: string;
  cloudUrl: string;
  nodeName?: string;
}): Promise<void> {
  const entry = deps.resolveLocalSurfaceEntry();
  const connectionFields = [
    `    workspace: ${JSON.stringify(input.workspace)},`,
    `    workspaceToken: ${JSON.stringify(input.workspaceToken)},`,
    `    cloudUrl: ${JSON.stringify(input.cloudUrl)}`
  ].join('\n');
  const contents = `// Generated by \`agentworkforce local-surface\`. Contains a workspace-scoped
// token — treat like any other credential (0600 perms, do not commit).
import { defineWorkforcePersonaNode } from ${JSON.stringify(entry)};

export default defineWorkforcePersonaNode({
  personaPath: ${JSON.stringify(input.personaPath)},
  channel: ${JSON.stringify(input.channel)},
  connection: {
${connectionFields}
  }${input.nodeName ? `,\n  nodeName: ${JSON.stringify(input.nodeName)}` : ''}
});
`;
  await deps.mkdir(path.dirname(input.configPath), { recursive: true, mode: 0o700 });
  await deps.writeFile(input.configPath, contents, { encoding: 'utf8', mode: 0o600 });
}

async function runRelayNodeUp(configPath: string, nodeName: string | undefined): Promise<void> {
  const relayArgs = ['node', 'up', '--config', configPath, ...(nodeName ? ['--name', nodeName] : [])];
  deps.log(`local-surface: relay ${relayArgs.join(' ')}`);
  const code = await new Promise<number>((resolve, reject) => {
    const child = deps.spawn('relay', relayArgs, { stdio: 'inherit' });
    child.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error('`relay` CLI not found on PATH. Install @agent-relay/cli, then re-run this command.')
        );
        return;
      }
      reject(err);
    });
    child.once('exit', (exitCode, signal) => {
      resolve(typeof exitCode === 'number' ? exitCode : signal ? 1 : 0);
    });
  });
  process.exitCode = code;
}
