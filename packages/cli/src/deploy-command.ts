import path from 'node:path';
import {
  createTerminalIO,
  deploy,
  resolveWorkspaceToken,
  type DeployMode,
  type DeployOptions,
  type ModeLaunchHandle
} from '@agentworkforce/deploy';

const DEFAULT_CLOUD_URL = 'https://agentrelay.com';

/**
 * Argv parser + dispatcher for `agentworkforce deploy <persona-path> [flags]`.
 * Keeps cli.ts itself slim — the file is already a large dispatcher and
 * each command lands in its own module when it grows past trivial.
 */
export async function runDeploy(args: readonly string[]): Promise<void> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    process.stdout.write(DEPLOY_USAGE);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const parsed = parseDeployArgs(args);

  try {
    const result = await deploy(parsed);
    if (parsed.dryRun) {
      process.stdout.write(`\nok: ${result.deploymentId} (dry-run)\n`);
      process.exit(0);
    }
    if (parsed.bundleOut) {
      process.stdout.write(`\nbundle: ${result.bundleDir}\n`);
      process.exit(0);
    }
    process.stdout.write(
      `\nok: ${result.deploymentId} (mode=${result.mode}, workspace=${result.workspace})\n`
    );

    // `--detach` returns immediately; otherwise the CLI blocks on the
    // runner's `done` promise so logs keep streaming in the foreground
    // and Ctrl-C tears the runner down cleanly.
    if (parsed.detach || !isRunHandle(result.runHandle)) {
      process.exit(0);
    }
    const exit = await result.runHandle.done;
    process.exit(exit.code);
  } catch (err) {
    process.stderr.write(
      `\nagentworkforce deploy failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}

function isRunHandle(value: unknown): value is ModeLaunchHandle {
  if (typeof value !== 'object' || value === null || !('done' in value)) {
    return false;
  }
  const done = (value as { done?: unknown }).done;
  return typeof done === 'object' && done !== null && typeof (done as { then?: unknown }).then === 'function';
}

export async function runLogin(args: readonly string[]): Promise<void> {
  if (args.length > 0 && (args[0] === '-h' || args[0] === '--help')) {
    process.stdout.write(LOGIN_USAGE);
    process.exit(0);
  }

  const opts = parseLoginArgs(args);
  const io = createTerminalIO();
  const workspace = opts.workspace
    ?? process.env.WORKFORCE_WORKSPACE_ID?.trim()
    ?? (await io.prompt('Workspace ID')).trim();
  if (!workspace) {
    process.stderr.write('agentworkforce login failed: workspace is required; pass --workspace or set WORKFORCE_WORKSPACE_ID\n');
    process.exit(1);
  }

  const cloudUrl = normalizeCloudUrl(
    opts.cloudUrl
      ?? process.env.WORKFORCE_DEPLOY_CLOUD_URL
      ?? process.env.WORKFORCE_CLOUD_URL
      ?? DEFAULT_CLOUD_URL
  );

  try {
    await resolveWorkspaceToken({ workspace, cloudUrl, io });
    process.stdout.write(`\nlogged in: ${workspace}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `\nagentworkforce login failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}

const DEPLOY_USAGE = `usage: agentworkforce deploy <persona-path> [flags]

Flags:
  --mode dev|sandbox|cloud    Pick a run mode (default: sandbox if Daytona/workspace creds resolve, else dev)
  --workspace <name>           Workforce workspace; defaults to the active workspace
  --no-connect                 Skip integration-connect prompts; fail if any are missing
  --byo-sandbox                Force BYO Daytona auth even when logged in
  --detach                     Background the runner instead of streaming logs
  --bundle-out <dir>           Emit the bundle to <dir> and exit (no launch)
  --dry-run                    Validate the persona and exit before any side effects
  --cloud-url <url>            Override the workforce cloud base URL
  --no-prompt                  Fail instead of prompting for cloud setup
  --harness-source <source>    Cloud harness source: plan, byok, or oauth
  --byok-key <key>             API key for --harness-source byok
  --on-exists <choice>         Existing cloud persona behavior: cancel, update, or destroy
  --input <key>=<value>        Override a declared persona input (repeatable)
  -h, --help                   Print this message
`;

const LOGIN_USAGE = `usage: agentworkforce login [flags]

Connect this machine to a workforce workspace using the browser OAuth flow.
The resulting workspace token is stored in the OS keychain when available,
falling back to ~/.agentworkforce/login.json.

Flags:
  --workspace <name>          Workforce workspace; defaults to WORKFORCE_WORKSPACE_ID or prompt
  --cloud-url <url>           Override the workforce cloud base URL
  -h, --help                  Print this message
`;

const HARNESS_SOURCES = ['plan', 'byok', 'oauth'] as const;
const ON_EXISTS_CHOICES = ['update', 'destroy', 'cancel'] as const;

export function parseDeployArgs(args: readonly string[]): DeployOptions {
  let personaPath: string | undefined;
  let mode: DeployMode | undefined;
  let workspace: string | undefined;
  let noConnect = false;
  let byoSandbox = false;
  let detach = false;
  let bundleOut: string | undefined;
  let dryRun = false;
  let cloudUrl: string | undefined;
  let noPrompt = false;
  let harnessSource: DeployOptions['harnessSource'];
  let byokKey: string | undefined;
  let onExists: DeployOptions['onExists'];
  const inputs: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(DEPLOY_USAGE);
      process.exit(0);
    } else if (a === '--mode') {
      const v = args[++i];
      if (v !== 'dev' && v !== 'sandbox' && v !== 'cloud') {
        die(`--mode: expected one of dev|sandbox|cloud; got "${v ?? ''}"`);
      }
      mode = v;
    } else if (a === '--workspace') {
      workspace = expectValue('--workspace', args[++i]);
    } else if (a === '--no-connect') {
      noConnect = true;
    } else if (a === '--byo-sandbox') {
      byoSandbox = true;
    } else if (a === '--detach') {
      detach = true;
    } else if (a === '--bundle-out') {
      bundleOut = expectValue('--bundle-out', args[++i]);
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--cloud-url') {
      cloudUrl = expectValue('--cloud-url', args[++i]);
    } else if (a.startsWith('--cloud-url=')) {
      cloudUrl = expectInlineValue('--cloud-url', a.slice('--cloud-url='.length));
    } else if (a === '--no-prompt') {
      noPrompt = true;
      noConnect = true;
    } else if (a === '--harness-source') {
      harnessSource = expectChoice('--harness-source', expectValue('--harness-source', args[++i]), HARNESS_SOURCES);
    } else if (a.startsWith('--harness-source=')) {
      harnessSource = expectChoice('--harness-source', expectInlineValue('--harness-source', a.slice('--harness-source='.length)), HARNESS_SOURCES);
    } else if (a === '--byok-key') {
      byokKey = expectValue('--byok-key', args[++i]);
    } else if (a.startsWith('--byok-key=')) {
      byokKey = expectInlineValue('--byok-key', a.slice('--byok-key='.length));
    } else if (a === '--on-exists') {
      onExists = expectChoice('--on-exists', expectValue('--on-exists', args[++i]), ON_EXISTS_CHOICES);
    } else if (a.startsWith('--on-exists=')) {
      onExists = expectChoice('--on-exists', expectInlineValue('--on-exists', a.slice('--on-exists='.length)), ON_EXISTS_CHOICES);
    } else if (a === '--input') {
      parseDeployInputValue(expectDeployInputValue(args[++i]), inputs);
    } else if (a.startsWith('--input=')) {
      parseDeployInputValue(a.slice('--input='.length), inputs);
    } else if (a.startsWith('--')) {
      die(`deploy: unknown flag "${a}"`);
    } else if (!personaPath) {
      personaPath = path.resolve(a);
    } else {
      die(`deploy: unexpected positional argument "${a}"`);
    }
  }

  if (!personaPath) {
    die('deploy: missing persona path. Usage: agentworkforce deploy <persona-path>');
  }

  return {
    personaPath,
    ...(mode ? { mode } : {}),
    ...(workspace ? { workspace } : {}),
    ...(noConnect ? { noConnect: true } : {}),
    ...(byoSandbox ? { byoSandbox: true } : {}),
    ...(detach ? { detach: true } : {}),
    ...(bundleOut ? { bundleOut } : {}),
    ...(dryRun ? { dryRun: true } : {}),
    ...(cloudUrl ? { cloudUrl } : {}),
    ...(noPrompt ? { noPrompt: true } : {}),
    ...(harnessSource ? { harnessSource } : {}),
    ...(byokKey ? { byokKey } : {}),
    ...(onExists ? { onExists } : {}),
    ...(Object.keys(inputs).length > 0 ? { inputs } : {})
  };
}

function expectDeployInputValue(value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
    die('--input: expected <key>=<value>');
  }
  return value;
}

function parseDeployInputValue(raw: string, inputs: Record<string, string>): void {
  const eq = raw.indexOf('=');
  if (eq <= 0) {
    die(`--input: expected <key>=<value>; got "${raw}"`);
  }
  const key = raw.slice(0, eq);
  inputs[key] = raw.slice(eq + 1);
}

function expectValue(flag: string, value: string | undefined): string {
  if (typeof value !== 'string' || !value.trim()) {
    die(`${flag}: missing value`);
  }
  // Reject the next token if it looks like a flag — `--workspace --detach`
  // should fail loudly rather than silently treating `--detach` as the
  // workspace name.
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

function expectChoice<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) {
    die(`${flag}: expected one of ${allowed.join('|')}; got "${value}"`);
  }
  return value as T;
}

function parseLoginArgs(args: readonly string[]): { workspace?: string; cloudUrl?: string } {
  let workspace: string | undefined;
  let cloudUrl: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(LOGIN_USAGE);
      process.exit(0);
    } else if (a === '--workspace') {
      workspace = expectValue('--workspace', args[++i]);
    } else if (a.startsWith('--workspace=')) {
      workspace = expectInlineValue('--workspace', a.slice('--workspace='.length));
    } else if (a === '--cloud-url') {
      cloudUrl = expectValue('--cloud-url', args[++i]);
    } else if (a.startsWith('--cloud-url=')) {
      cloudUrl = expectInlineValue('--cloud-url', a.slice('--cloud-url='.length));
    } else {
      die(`login: unknown argument "${a}"`);
    }
  }

  return {
    ...(workspace ? { workspace } : {}),
    ...(cloudUrl ? { cloudUrl } : {})
  };
}

function normalizeCloudUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : DEFAULT_CLOUD_URL;
}

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
