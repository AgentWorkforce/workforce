import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  fetchDeployments,
  requestJson,
  resolveAgentSelector,
  resolveDeploymentRequestContext,
  type DeploymentAgent
} from './list-command.js';

export const RUNS_USAGE = `usage: agentworkforce runs export <runId> [flags]

Export the gateway envelope cloud actually delivered to a run as a
replayable \`agentworkforce invoke --fixture\` fixture (workforce#189 /
cloud#1841). The fixture IS cloud's normalized output, so local replay
cannot drift from production normalization.

Flags:
  --agent <selector>     Agent the run belongs to (agentId, deployedName,
                         or persona slug). Without it, every agent in the
                         workspace is checked for the run id.
  --fixture <file>       Write the envelope fixture to <file>.
                         Default: stdout.
  --workspace <name>     Workforce workspace; defaults to the active one.
  --cloud-url <url>      Override the workforce cloud base URL.
  --no-prompt            Fail instead of prompting for login.
  -h, --help             Print this message.

Exit codes: 0 exported; 1 run not found / envelope not captured / errors.
`;

export interface RunsExportOptions {
  runId: string;
  agent?: string;
  fixturePath?: string;
  workspace?: string;
  cloudUrl?: string;
  noPrompt?: boolean;
}

export type ParsedRunsArgs = { action: 'export'; options: RunsExportOptions } | { help: true };

export function parseRunsArgs(args: readonly string[]): ParsedRunsArgs {
  const [action, ...rest] = args;
  if (!action || action === '-h' || action === '--help') {
    return { help: true };
  }
  if (action !== 'export') {
    throw new Error(`runs: unknown action "${action}". Expected: export`);
  }

  let runId: string | undefined;
  let agent: string | undefined;
  let fixturePath: string | undefined;
  let workspace: string | undefined;
  let cloudUrl: string | undefined;
  let noPrompt = false;

  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '-h' || a === '--help') {
      return { help: true };
    } else if (a === '--agent') {
      agent = expectValue('--agent', rest[++i]);
    } else if (a.startsWith('--agent=')) {
      agent = expectInline('--agent', a.slice('--agent='.length));
    } else if (a === '--fixture') {
      fixturePath = expectValue('--fixture', rest[++i]);
    } else if (a.startsWith('--fixture=')) {
      fixturePath = expectInline('--fixture', a.slice('--fixture='.length));
    } else if (a === '--workspace') {
      workspace = expectValue('--workspace', rest[++i]);
    } else if (a === '--cloud-url') {
      cloudUrl = expectValue('--cloud-url', rest[++i]);
    } else if (a === '--no-prompt') {
      noPrompt = true;
    } else if (a.startsWith('--')) {
      throw new Error(`runs export: unknown flag "${a}"`);
    } else if (!runId) {
      runId = a;
    } else {
      throw new Error(`runs export: unexpected positional argument "${a}"`);
    }
  }

  if (!runId) {
    throw new Error('runs export: missing run id. Usage: agentworkforce runs export <runId>');
  }

  return {
    action: 'export',
    options: {
      runId,
      ...(agent ? { agent } : {}),
      ...(fixturePath ? { fixturePath: path.resolve(fixturePath) } : {}),
      ...(workspace ? { workspace } : {}),
      ...(cloudUrl ? { cloudUrl } : {}),
      ...(noPrompt ? { noPrompt: true } : {})
    }
  };
}

function expectValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`runs export: ${flag} expects a value`);
  }
  return value;
}

function expectInline(flag: string, value: string): string {
  if (!value) throw new Error(`runs export: ${flag} expects a value`);
  return value;
}

type EnvelopeResponse = {
  captured?: unknown;
  omitted?: unknown;
  envelope?: unknown;
};

export interface RunsIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIO: RunsIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
};

/**
 * Fetch the captured envelope for a run. The envelope endpoint is
 * agent-scoped (`/deployments/:agentId/runs/:runId/envelope`), so with no
 * --agent selector every workspace agent is probed for the run id (404 =
 * not this agent's run; bounded by the workspace's agent count).
 */
export async function runRuns(args: readonly string[], io: RunsIO = defaultIO): Promise<void> {
  let parsed: ParsedRunsArgs;
  try {
    parsed = parseRunsArgs(args);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n\n${RUNS_USAGE}`);
    process.exitCode = 1;
    return;
  }
  if ('help' in parsed) {
    io.stdout(RUNS_USAGE);
    return;
  }

  try {
    await runRunsExport(parsed.options, io);
  } catch (err) {
    io.stderr(`runs export: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

async function runRunsExport(opts: RunsExportOptions, io: RunsIO): Promise<void> {
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
  const candidates: DeploymentAgent[] = opts.agent
    ? [resolveAgentSelector(agents, opts.agent)]
    : agents;
  if (candidates.length === 0) {
    throw new Error(`no deployed agents found in workspace ${ctx.workspace}`);
  }

  let payload: EnvelopeResponse | null = null;
  let matchedAgent: DeploymentAgent | null = null;
  for (const agent of candidates) {
    const url = new URL(
      `/api/v1/workspaces/${encodeURIComponent(ctx.workspace)}` +
        `/deployments/${encodeURIComponent(agent.agentId)}` +
        `/runs/${encodeURIComponent(opts.runId)}/envelope`,
      ctx.cloudUrl
    );
    try {
      payload = await requestJson<EnvelopeResponse>(url, ctx.token, 'runs export');
      matchedAgent = agent;
      break;
    } catch {
      // 404 = not this agent's run (or auth/transient on this probe);
      // keep scanning the remaining candidates.
      continue;
    }
  }

  if (!payload || !matchedAgent) {
    throw new Error(
      `run ${opts.runId} not found in workspace ${ctx.workspace}` +
        `${opts.agent ? ` for agent "${opts.agent}"` : ` across ${candidates.length} agent(s)`}. ` +
        'Check the run id (dashboard run detail, or `agentworkforce deployments list`).'
    );
  }

  const interpreted = interpretEnvelopeResponse(payload, opts.runId, matchedAgent.deployedName);
  if (!interpreted.ok) {
    throw new Error(interpreted.error);
  }

  const fixture = interpreted.fixture;
  if (opts.fixturePath) {
    await writeFile(opts.fixturePath, fixture, 'utf8');
    io.stderr(
      `exported envelope for run ${opts.runId} (agent ${matchedAgent.deployedName}) to ${opts.fixturePath}\n` +
        `replay with: agentworkforce invoke <persona-path> --fixture ${opts.fixturePath}\n`
    );
  } else {
    io.stdout(fixture);
  }
}

/**
 * Interpret the envelope endpoint's response into either a fixture text or
 * a user-actionable error. Exported for unit tests.
 */
export function interpretEnvelopeResponse(
  payload: EnvelopeResponse,
  runId: string,
  agentName: string
): { ok: true; fixture: string } | { ok: false; error: string } {
  if (payload.captured === true && payload.envelope !== null && payload.envelope !== undefined) {
    return { ok: true, fixture: `${JSON.stringify(payload.envelope, null, 2)}\n` };
  }
  if (payload.omitted === true) {
    return {
      ok: false,
      error:
        `run ${runId} (agent ${agentName}): the envelope was too large to capture ` +
        '(omitted at write time — never truncated, a partial envelope would replay wrong). ' +
        'Use `agentworkforce invoke --scaffold <type>` to author a fixture by hand.'
    };
  }
  return {
    ok: false,
    error:
      `run ${runId} (agent ${agentName}): no envelope was captured for this run ` +
      '(runs before cloud#1841 deployed predate capture). ' +
      'Re-fire the agent or use `agentworkforce invoke --scaffold <type>`.'
  };
}
