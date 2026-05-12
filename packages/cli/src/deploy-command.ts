import path from 'node:path';
import {
  deploy,
  type DeployMode,
  type DeployOptions,
  type ModeLaunchHandle
} from '@agentworkforce/deploy';

/**
 * Argv parser + dispatcher for `workforce deploy <persona-path> [flags]`.
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
      `\nworkforce deploy failed: ${err instanceof Error ? err.message : String(err)}\n`
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
  process.stderr.write(
    'The browser-based workforce login flow is rolling out in stages and is not on by default yet.\n' +
      'For now, export your workspace credentials in the shell:\n\n' +
      '  export WORKFORCE_WORKSPACE_ID=<workspace-id>\n' +
      '  export WORKFORCE_WORKSPACE_TOKEN=<workspace-token>\n\n' +
      'Then re-run `workforce deploy ./your-persona.json`.\n'
  );
  process.exit(1);
}

const DEPLOY_USAGE = `usage: workforce deploy <persona-path> [flags]

Flags:
  --mode dev|sandbox|cloud    Pick a run mode (default: sandbox if Daytona/workspace creds resolve, else dev)
  --workspace <name>           Workforce workspace; defaults to the active workspace
  --no-connect                 Skip integration-connect prompts; fail if any are missing
  --byo-sandbox                Force BYO Daytona auth even when logged in
  --detach                     Background the runner instead of streaming logs
  --bundle-out <dir>           Emit the bundle to <dir> and exit (no launch)
  --dry-run                    Validate the persona and exit before any side effects
  --cloud-url <url>            Override the workforce cloud base URL
  -h, --help                   Print this message
`;

const LOGIN_USAGE = `usage: workforce login

Connect this machine to a workforce workspace. The full OAuth flow ships
once the cloud login surface is live; until then, set:

  export WORKFORCE_WORKSPACE_ID=...
  export WORKFORCE_WORKSPACE_TOKEN=...
`;

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
    } else if (a.startsWith('--')) {
      die(`deploy: unknown flag "${a}"`);
    } else if (!personaPath) {
      personaPath = path.resolve(a);
    } else {
      die(`deploy: unexpected positional argument "${a}"`);
    }
  }

  if (!personaPath) {
    die('deploy: missing persona path. Usage: workforce deploy <persona-path>');
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
    ...(cloudUrl ? { cloudUrl } : {})
  };
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

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
