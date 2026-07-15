import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import { createTerminalIO, preflightPersona, resolveCloudUrl, resolveWorkspaceToken } from '@agentworkforce/deploy';

export const LOCAL_SURFACE_USAGE = `usage: agentworkforce local-surface <persona-path> [flags]

Run a proactive persona on this machine, triggered by real provider webhooks
routed through the fleet/relaycast infrastructure — no public IP, tunnel, or
manual token wiring required. The persona runs in \`--mode dev\`; local
credential mirroring is NOT supported (workforce#local-surface-plan), so this
is safe for cron/timer-only or webhook-shape-only personas that don't need a
per-connection integration credential resolved locally.

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
  --channel <name>          The relaycast channel Cloud bound this persona's
                             local-surface webhook to (from the Cloud
                             dashboard's "enable local surface" action for
                             this persona — that action is session-gated,
                             so this CLI cannot resolve it on its own). Only
                             needed the first time per persona+workspace on
                             this machine — cached in
                             ~/.agentworkforce/local-surface/state.json and
                             reused on subsequent runs.
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
  channel?: string;
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
    } else if (a === '--channel') {
      opts.channel = expectValue('--channel', args[++i]);
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

export interface LocalSurfaceBinding {
  channel: string;
  relayWorkspaceId?: string;
  boundAt: string;
}

export interface LocalSurfaceCommandDeps {
  resolveWorkspaceToken: typeof resolveWorkspaceToken;
  resolveActiveFleetNodeEnrollment: typeof resolveActiveFleetNodeEnrollment;
  enrollFleetNode: typeof enrollFleetNode;
  upsertFleetNodeEnrollment: typeof upsertFleetNodeEnrollment;
  preflightPersona: typeof preflightPersona;
  spawn: typeof spawnChild;
  readFile: typeof readFile;
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
  spawn: spawnChild,
  readFile,
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
 * 2. Reuse a persisted fleet-node enrollment, or redeem `--enrollment-token`
 *    (minting one requires a browser session — `POST
 *    /api/v1/fleet/enrollment-tokens` is session-cookie-gated, so a headless
 *    CLI can only redeem an already-minted token, via the same
 *    `enrollFleetNode`/`upsertFleetNodeEnrollment` store `relay cloud enroll`
 *    and `relay node up` already read/write).
 * 3. Resolve the persona's bound relaycast channel: `POST
 *    /api/v1/fleet/local-surface` (the route that opts a persona in and
 *    returns its channel) is ALSO session-cookie-gated — same reason as
 *    step 2 — so this CLI can't call it either. `--channel` (from wherever
 *    Cloud's dashboard surfaces that opt-in action) is cached locally after
 *    the first run instead.
 * 4. Write a node-config file that default-exports
 *    `defineWorkforcePersonaNode(...)`.
 * 5. Shell out to `relay node up --config <file>`.
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

  const enrollment = await resolveOrRedeemEnrollment({ workspace, opts, cloudUrl });
  deps.log(`local-surface: fleet node "${enrollment.nodeName}" (${enrollment.relaycastUrl})`);

  const binding = await resolveChannelBinding({ workspace, personaId: preflight.persona.id, opts });
  deps.log(`local-surface: channel "${binding.channel}"`);

  const configPath = opts.configOut
    ? path.resolve(opts.configOut)
    : defaultConfigPath(preflight.persona.id);
  await writeNodeConfig({
    configPath,
    personaPath: preflight.personaPath,
    channel: binding.channel,
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
          channel: binding.channel,
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

interface LocalSurfaceState {
  version: 1;
  bindings: Record<string, LocalSurfaceBinding>;
}

function localSurfaceStatePath(): string {
  return path.join(os.homedir(), '.agentworkforce', 'local-surface', 'state.json');
}

function bindingKey(workspace: string, personaId: string): string {
  return `${workspace}#${personaId}`;
}

function isLocalSurfaceState(value: unknown): value is LocalSurfaceState {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { bindings?: unknown }).bindings === 'object' &&
    (value as { bindings?: unknown }).bindings !== null
  );
}

async function readLocalSurfaceState(): Promise<LocalSurfaceState> {
  const file = localSurfaceStatePath();
  let raw: string;
  try {
    raw = await deps.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { version: 1, bindings: {} };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `local-surface state file at ${file} is corrupt (${
        err instanceof Error ? err.message : String(err)
      }). Repair or remove it, then re-run with --channel.`
    );
  }
  return isLocalSurfaceState(parsed) ? parsed : { version: 1, bindings: {} };
}

/**
 * `POST /api/v1/fleet/local-surface` — the route that opts a persona into
 * local-surface mode and returns its bound relaycast channel — is
 * session-cookie-gated (org-owner-only), same as `/api/v1/fleet/
 * enrollment-tokens`. A headless CLI's workspace bearer token can never
 * satisfy that gate, so unlike enrollment (which this CLI CAN redeem given a
 * token minted elsewhere) it cannot even attempt the call. `--channel`
 * carries the value obtained from wherever Cloud surfaces that opt-in
 * action; it's cached locally so it's only needed once per persona+workspace.
 */
async function resolveChannelBinding(input: {
  workspace: string;
  personaId: string;
  opts: LocalSurfaceOptions;
}): Promise<LocalSurfaceBinding> {
  const state = await readLocalSurfaceState();
  const key = bindingKey(input.workspace, input.personaId);
  const channelFlag = input.opts.channel?.trim();
  if (channelFlag) {
    const binding: LocalSurfaceBinding = { channel: channelFlag, boundAt: deps.now().toISOString() };
    const file = localSurfaceStatePath();
    await deps.mkdir(path.dirname(file), { recursive: true });
    await deps.writeFile(
      file,
      JSON.stringify({ version: 1, bindings: { ...state.bindings, [key]: binding } }, null, 2),
      'utf8'
    );
    return binding;
  }

  const existing = state.bindings[key];
  if (existing) {
    return existing;
  }
  throw new Error(
    `no local-surface channel known for persona "${input.personaId}" in workspace ${input.workspace}. ` +
      'Enable local-surface for this persona from the Cloud dashboard, then re-run with --channel <name>.'
  );
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
