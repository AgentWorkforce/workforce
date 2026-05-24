import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { accessSync, statSync } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildNonInteractiveSpec,
  renderPersonaInputs,
  resolveMcpServersLenient,
  resolvePersonaInputs,
  resolveStringMapLenient,
  type PersonaSpec
} from '@agentworkforce/persona-kit';
import { createGithubClient } from './clients/github.js';
import { createJiraClient } from './clients/jira.js';
import { createLinearClient } from './clients/linear.js';
import { createNotionClient } from './clients/notion.js';
import { createSlackClient } from './clients/slack.js';
import type {
  FilesContext,
  HarnessRunArgs,
  HarnessRunResult,
  HarnessUsage,
  SandboxContext,
  TeamContext,
  TeamHandle,
  TeamResult,
  TeamSpawnArgs,
  TeamStatus,
  WorkforceAgentContext,
  WorkforceCtx,
  WorkforceDeploymentContext,
  WorkflowContext
} from './types.js';

type AgentInputValue = string | number | boolean | null | undefined;
type TeamMemberStatusPayload = Record<string, unknown>;
type TeamMemberResultPayload = {
  status: string;
  output: string;
  resultId?: string;
};
const USAGE_REPORT_TIMEOUT_MS = 5_000;
const WORKFLOW_COMPLETION_POLL_MS = 1_000;
const WORKFLOW_COMPLETION_TIMEOUT_MS = 90 * 60_000;
const WORKFLOW_FETCH_TIMEOUT_MS = 15_000;
const WORKFLOW_COMPLETION_MAX_TRANSIENT_ERRORS = 3;
const WORKFLOW_INVOCATION_HEADER = 'x-agentworkforce-workspace-workflow-invocation';
const TEAM_COMPLETION_POLL_MS = 1_000;
const TEAM_COMPLETION_TIMEOUT_MS = 21_600 * 1_000;
const TEAM_FETCH_TIMEOUT_MS = 15_000;
const TEAM_COMPLETION_MAX_TRANSIENT_ERRORS = 3;

interface AgentRowContext extends WorkforceAgentContext {
  input_values?: Record<string, AgentInputValue>;
  inputValues?: Record<string, AgentInputValue>;
}

class WorkflowRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'WorkflowRequestError';
  }
}

export interface CloudDefaultOptions {
  persona: PersonaSpec;
  agent: AgentRowContext;
  deployment: WorkforceDeploymentContext;
  workspaceId: string;
  log: WorkforceCtx['log'];
  env?: NodeJS.ProcessEnv;
}

export interface CloudRuntimeDefaults {
  sandbox: SandboxContext;
  files: FilesContext;
  integrations?: Record<string, unknown>;
  workflow?: WorkflowContext;
  team?: TeamContext;
  harnessRunner: (args: HarnessRunArgs) => Promise<HarnessRunResult>;
}

export function createCloudRuntimeDefaults(options: CloudDefaultOptions): CloudRuntimeDefaults {
  const env = options.env ?? process.env;
  const root = resolveCloudWorkspaceRoot(env);
  const sandbox = createProcessSandbox(root, env);
  const files = filesFromSandbox(sandbox);
  const integrations = createDefaultIntegrations({
    persona: options.persona,
    workspaceId: options.workspaceId,
    workspaceRoot: root,
    env
  });
  const workflow = createDefaultWorkflow({
    workspaceRoot: root,
    env
  });
  const team = createDefaultTeam({
    workspaceId: options.workspaceId,
    parentAgentId: firstNonEmpty(options.agent.id, env.WORKFORCE_AGENT_ID),
    env
  });
  return {
    sandbox,
    files,
    ...(integrations ? { integrations } : {}),
    ...(workflow ? { workflow } : {}),
    ...(team ? { team } : {}),
    harnessRunner: createProcessHarnessRunner({
      ...options,
      workspaceRoot: root,
      env
    })
  };
}

function resolveCloudWorkspaceRoot(env: NodeJS.ProcessEnv): string {
  const configured = firstNonEmpty(
    env.WORKFORCE_SANDBOX_ROOT,
    env.WORKFORCE_WORKSPACE_DIR,
    env.RELAYFILE_MOUNT_ROOT,
    env.RELAYFILE_ROOT
  );
  if (configured) return path.resolve(configured);
  return canAccessSync('/workspace') ? '/workspace' : process.cwd();
}

function canAccessSync(candidate: string): boolean {
  try {
    accessSync(candidate, constants.R_OK | constants.W_OK);
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function createProcessSandbox(root: string, env: NodeJS.ProcessEnv): SandboxContext {
  const cwd = path.resolve(root);
  return {
    cwd,
    async exec(cmd, opts) {
      const execCwd = resolveWorkspacePath(cwd, opts?.cwd ?? cwd);
      await assertDirectory(execCwd);
      const startedAt = Date.now();
      const result = await spawnAndCapture({
        bin: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        args: process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-lc', cmd],
        cwd: execCwd,
        env: { ...env, ...(opts?.env ?? {}) },
        timeoutMs: opts?.timeoutMs
      });
      return {
        output: result.output || result.stderr,
        exitCode: result.exitCode
      };
    },
    async readFile(filePath) {
      return readFile(resolveWorkspacePath(cwd, filePath), 'utf8');
    },
    async writeFile(filePath, contents) {
      const target = resolveWorkspacePath(cwd, filePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, 'utf8');
    }
  };
}

function filesFromSandbox(sandbox: SandboxContext): FilesContext {
  return {
    read(path) {
      return sandbox.readFile(path);
    },
    write(path, contents) {
      return sandbox.writeFile(path, contents);
    }
  };
}

function createDefaultIntegrations(args: {
  persona: PersonaSpec;
  workspaceId: string;
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
}): Record<string, unknown> | undefined {
  const integrations: Record<string, unknown> = {};
  const common = {
    relayfileMountRoot: firstNonEmpty(args.env.RELAYFILE_MOUNT_ROOT, args.env.RELAYFILE_ROOT) ?? args.workspaceRoot,
    workspaceCwd: args.workspaceRoot,
    workspaceId: args.workspaceId,
    writebackTimeoutMs: numberFromEnv(args.env.WORKFORCE_RELAYFILE_WRITEBACK_TIMEOUT_MS),
    writebackPollMs: numberFromEnv(args.env.WORKFORCE_RELAYFILE_WRITEBACK_POLL_MS),
    relayfileBaseUrl: args.env.RELAYFILE_BASE_URL,
    relayfileApiToken: args.env.RELAYFILE_TOKEN
  };
  const workspaceCloudApiToken = firstNonEmpty(args.env.WORKFORCE_WORKSPACE_TOKEN);
  const cloudApiToken = firstNonEmpty(workspaceCloudApiToken, args.env.WORKFORCE_AGENT_TOKEN);
  if (args.persona.integrations?.github) {
    integrations.github = createGithubClient({
      ...common,
      connectionId: args.env.WORKFORCE_INTEGRATION_GITHUB_CONNECTION_ID,
      cloudApiToken
    });
  }
  if (args.persona.integrations?.slack && workspaceCloudApiToken) {
    integrations.slack = createSlackClient({
      ...common,
      connectionId: args.env.WORKFORCE_INTEGRATION_SLACK_CONNECTION_ID,
      cloudApiToken: workspaceCloudApiToken,
      slackTeamId: args.env.WORKFORCE_INTEGRATION_SLACK_TEAM_ID
    });
  }
  if (args.persona.integrations?.linear) {
    integrations.linear = createLinearClient({
      ...common,
      connectionId: args.env.WORKFORCE_INTEGRATION_LINEAR_CONNECTION_ID
    });
  }
  if (args.persona.integrations?.notion) {
    integrations.notion = createNotionClient({
      ...common,
      connectionId: args.env.WORKFORCE_INTEGRATION_NOTION_CONNECTION_ID
    });
  }
  if (args.persona.integrations?.jira && workspaceCloudApiToken) {
    integrations.jira = createJiraClient({
      ...common,
      connectionId: args.env.WORKFORCE_INTEGRATION_JIRA_CONNECTION_ID,
      cloudApiToken: workspaceCloudApiToken
    });
  }
  return Object.keys(integrations).length > 0 ? integrations : undefined;
}

function createDefaultWorkflow(args: {
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
}): WorkflowContext | undefined {
  const token = firstNonEmpty(args.env.WORKFORCE_WORKSPACE_TOKEN);
  const baseUrl = firstNonEmpty(args.env.WORKFORCE_CLOUD_BASE_URL);
  if (!token || !baseUrl) return undefined;
  const base = normalizeBaseUrl(baseUrl);
  return {
    async run(name, runArgs) {
      const workflowSource = await readBundledWorkflowSource(args.workspaceRoot, name);
      const response = await fetchWorkflow(`${base}/api/v1/workflows/run`, {
        method: 'POST',
        headers: workflowHeaders(token, true),
        body: JSON.stringify({
          workflow: workflowSource,
          fileType: 'ts',
          sourceFileType: 'workflow',
          runtime: { id: 'daytona' },
          metadata: {
            invocationSlug: name,
            invocationArgs: JSON.stringify(runArgs ?? {})
          }
        })
      });
      if (!response.ok) {
        throw await workflowError(response, `ctx.workflow.run("${name}")`);
      }
      const payload = await response.json().catch(() => ({})) as { runId?: unknown };
      if (typeof payload.runId !== 'string' || payload.runId.trim().length === 0) {
        throw new Error(`ctx.workflow.run("${name}"): cloud response missing runId`);
      }
      const runId = payload.runId;
      return {
        runId,
        completion: () => pollWorkflowCompletion({ base, token, runId })
      };
    },
    status(runId) {
      return fetchWorkflowStatus({ base, token, runId });
    }
  };
}

function createDefaultTeam(args: {
  workspaceId: string;
  parentAgentId?: string;
  env: NodeJS.ProcessEnv;
}): TeamContext | undefined {
  const token = firstNonEmpty(args.env.WORKFORCE_WORKSPACE_TOKEN);
  const baseUrl = firstNonEmpty(args.env.WORKFORCE_CLOUD_BASE_URL);
  const workspaceId = firstNonEmpty(args.workspaceId);
  const parentAgentId = firstNonEmpty(args.parentAgentId);
  if (!token || !baseUrl || !workspaceId || !parentAgentId) return undefined;
  const base = normalizeBaseUrl(baseUrl);
  return {
    async spawn(spawnArgs: TeamSpawnArgs) {
      const response = await fetchTeam(`${base}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(parentAgentId)}/team`, {
        method: 'POST',
        headers: teamHeaders(token),
        body: JSON.stringify(spawnArgs)
      });
      if (!response.ok) {
        throw await teamError(response, 'ctx.team.spawn()');
      }
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (typeof payload.teamId !== 'string' || payload.teamId.trim().length === 0) {
        throw new Error('ctx.team.spawn(): cloud response missing teamId');
      }
      const teamId = payload.teamId.trim();
      return buildTeamHandle({
        base,
        token,
        workspaceId,
        teamId,
        channel: typeof payload.channel === 'string' && payload.channel.trim() ? payload.channel : `team-${teamId}`,
        sharedMountRoot: typeof payload.sharedMountRoot === 'string' && payload.sharedMountRoot.trim()
          ? payload.sharedMountRoot
          : `/teams/${teamId}`
      });
    },
    async attach(teamId: string) {
      const normalizedTeamId = normalizeTeamId(teamId, 'ctx.team.attach()');
      const handle = buildTeamHandle({
        base,
        token,
        workspaceId,
        teamId: normalizedTeamId,
        channel: `team-${normalizedTeamId}`,
        sharedMountRoot: `/teams/${normalizedTeamId}`
      });
      await handle.status();
      return handle;
    }
  };
}

function buildTeamHandle(args: {
  base: string;
  token: string;
  workspaceId: string;
  teamId: string;
  channel: string;
  sharedMountRoot: string;
}): TeamHandle {
  return {
    teamId: args.teamId,
    channel: args.channel,
    sharedMountRoot: args.sharedMountRoot,
    status() {
      return fetchTeamStatus(args);
    },
    completion() {
      return pollTeamCompletion(args);
    },
    async cancel() {
      const response = await fetchTeam(teamUrl(args, 'cancel'), {
        method: 'POST',
        headers: teamHeaders(args.token)
      });
      if (!response.ok) {
        throw await teamError(response, `ctx.team.attach("${args.teamId}").cancel()`);
      }
    }
  };
}

async function pollTeamCompletion(args: {
  base: string;
  token: string;
  workspaceId: string;
  teamId: string;
}): Promise<TeamResult> {
  const deadline = Date.now() + TEAM_COMPLETION_TIMEOUT_MS;
  let transientErrors = 0;
  let lastTransientError: unknown;
  while (Date.now() < deadline) {
    let status: TeamStatus;
    try {
      status = await fetchTeamStatus(args);
      transientErrors = 0;
      lastTransientError = undefined;
    } catch (err) {
      if (err instanceof WorkflowRequestError && err.retryable && transientErrors < TEAM_COMPLETION_MAX_TRANSIENT_ERRORS) {
        transientErrors += 1;
        lastTransientError = err;
        await delay(TEAM_COMPLETION_POLL_MS);
        continue;
      }
      throw err;
    }
    if (isTerminalTeamStatus(status.status)) {
      return {
        status: status.status,
        members: status.results ?? {},
        summary: status.summary ?? ''
      };
    }
    await delay(TEAM_COMPLETION_POLL_MS);
  }
  if (lastTransientError instanceof Error) {
    throw new Error(
      `ctx.team.attach("${args.teamId}").completion(): timed out after ${TEAM_COMPLETION_TIMEOUT_MS}ms; last status poll error: ${lastTransientError.message}`
    );
  }
  throw new Error(`ctx.team.attach("${args.teamId}").completion(): timed out after ${TEAM_COMPLETION_TIMEOUT_MS}ms`);
}

async function fetchTeamStatus(args: {
  base: string;
  token: string;
  workspaceId: string;
  teamId: string;
}): Promise<TeamStatus> {
  const teamId = normalizeTeamId(args.teamId, 'ctx.team.status()');
  const response = await fetchTeam(teamUrl({ ...args, teamId }), {
    method: 'GET',
    headers: teamHeaders(args.token)
  });
  if (!response.ok) {
    throw await teamError(response, `ctx.team.attach("${teamId}").status()`);
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  return normalizeTeamStatus({ ...body, teamId: typeof body.teamId === 'string' ? body.teamId : teamId });
}

function normalizeTeamStatus(body: Record<string, unknown>): TeamStatus {
  const teamId = typeof body.teamId === 'string' ? body.teamId : '';
  const status = canonicalTeamStatus(body.status);
  return {
    teamId,
    status,
    members: normalizeTeamMembers(body.members),
    results: normalizeTeamResults(body.results),
    summary: typeof body.summary === 'string' ? body.summary : ''
  };
}

function normalizeTeamMembers(value: unknown): TeamMemberStatusPayload[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function normalizeTeamResults(value: unknown): Record<string, TeamMemberResultPayload> {
  if (!isRecord(value)) return {};
  const results: Record<string, TeamMemberResultPayload> = {};
  for (const [name, result] of Object.entries(value)) {
    if (!isRecord(result)) continue;
    const status = typeof result.status === 'string' ? result.status : '';
    const output = typeof result.output === 'string' ? result.output : '';
    results[name] = {
      status,
      output,
      ...(typeof result.resultId === 'string' ? { resultId: result.resultId } : {})
    };
  }
  return results;
}

function canonicalTeamStatus(value: unknown): TeamStatus['status'] {
  switch (value) {
    case 'running':
      return 'running';
    case 'succeeded':
    case 'success':
    case 'completed':
    case 'complete':
      return 'succeeded';
    case 'failed':
    case 'failure':
      return 'failed';
    case 'timed_out':
    case 'timeout':
    case 'timed-out':
      return 'timed_out';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'starting':
    case 'pending':
    case 'queued':
    default:
      return 'starting';
  }
}

function isTerminalTeamStatus(status: TeamStatus['status']): status is TeamResult['status'] {
  return status === 'succeeded' || status === 'failed' || status === 'timed_out' || status === 'cancelled';
}

function normalizeTeamId(teamId: string, label: string): string {
  const trimmed = teamId.trim();
  if (!trimmed) {
    throw new Error(`${label} requires a non-empty teamId`);
  }
  return trimmed;
}

function teamUrl(args: {
  base: string;
  workspaceId: string;
  teamId: string;
}, suffix?: string): string {
  const url = `${args.base}/api/v1/workspaces/${encodeURIComponent(args.workspaceId)}/teams/${encodeURIComponent(args.teamId)}`;
  return suffix ? `${url}/${suffix}` : url;
}

function teamHeaders(token: string): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${token}`
  };
}

async function teamError(response: Response, label: string): Promise<Error> {
  const body = await response.text().catch(() => '');
  const excerpt = body.length > 400 ? `${body.slice(0, 400)}...` : body;
  return new WorkflowRequestError(
    `${label}: ${response.status} ${response.statusText}${excerpt ? ` - ${excerpt}` : ''}`,
    response.status === 401 || response.status === 429 || response.status >= 500
  );
}

async function fetchTeam(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEAM_FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    const message = err instanceof Error && err.name === 'AbortError'
      ? `timeout after ${TEAM_FETCH_TIMEOUT_MS}ms`
      : err instanceof Error ? err.message : String(err);
    throw new WorkflowRequestError(`team request failed: ${message}`, true);
  } finally {
    clearTimeout(timer);
  }
}

async function readBundledWorkflowSource(workspaceRoot: string, name: string): Promise<string> {
  const workflowFile = normalizeWorkflowName(name);
  const roots = uniqueStrings([process.cwd(), workspaceRoot]);
  const candidates = roots.flatMap((root) => [
    path.resolve(root, 'workflows', workflowFile),
    path.resolve(root, workflowFile)
  ]);
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8');
    } catch (err) {
      if (!isNoEntry(err)) throw err;
    }
  }
  throw new Error(
    `ctx.workflow.run("${name}") could not find bundled workflow source; expected ${candidates.join(' or ')}`
  );
}

function normalizeWorkflowName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('ctx.workflow.run() requires a non-empty workflow name');
  }
  if (path.isAbsolute(trimmed) || trimmed.split(/[\\/]/).some((segment) => segment === '..' || segment === '')) {
    throw new Error(`ctx.workflow.run("${name}") workflow name must be a safe relative path`);
  }
  return trimmed.endsWith('.ts') ? trimmed : `${trimmed}.ts`;
}

async function pollWorkflowCompletion(args: {
  base: string;
  token: string;
  runId: string;
}): Promise<{ output: unknown; status: 'success' | 'failure' }> {
  const deadline = Date.now() + WORKFLOW_COMPLETION_TIMEOUT_MS;
  let transientErrors = 0;
  let lastTransientError: unknown;
  while (Date.now() < deadline) {
    let status: Awaited<ReturnType<typeof fetchWorkflowStatus>>;
    try {
      status = await fetchWorkflowStatus(args);
      transientErrors = 0;
      lastTransientError = undefined;
    } catch (err) {
      if (err instanceof WorkflowRequestError && err.retryable && transientErrors < WORKFLOW_COMPLETION_MAX_TRANSIENT_ERRORS) {
        transientErrors += 1;
        lastTransientError = err;
        await delay(WORKFLOW_COMPLETION_POLL_MS);
        continue;
      }
      throw err;
    }
    if (status.status === 'success') {
      return { status: 'success', output: status.output };
    }
    if (status.status === 'failure') {
      return { status: 'failure', output: status.output ?? status.error };
    }
    await delay(WORKFLOW_COMPLETION_POLL_MS);
  }
  if (lastTransientError instanceof Error) {
    throw new Error(
      `ctx.workflow.run("${args.runId}").completion(): timed out after ${WORKFLOW_COMPLETION_TIMEOUT_MS}ms; last status poll error: ${lastTransientError.message}`
    );
  }
  throw new Error(`ctx.workflow.run("${args.runId}").completion(): timed out after ${WORKFLOW_COMPLETION_TIMEOUT_MS}ms`);
}

async function fetchWorkflowStatus(args: {
  base: string;
  token: string;
  runId: string;
}): Promise<{ status: 'pending' | 'running' | 'success' | 'failure'; output?: unknown; error?: string; patches?: unknown }> {
  const runId = args.runId.trim();
  if (!runId) {
    throw new Error('ctx.workflow.status() requires a non-empty runId');
  }
  const response = await fetchWorkflow(`${args.base}/api/v1/workflows/runs/${encodeURIComponent(runId)}`, {
    method: 'GET',
    headers: workflowHeaders(args.token, false)
  });
  if (!response.ok) {
    throw await workflowError(response, `ctx.workflow.status("${runId}")`);
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  const status = normalizeWorkflowStatus(body.status);
  const output = normalizeWorkflowOutput(body);
  return {
    status,
    ...(output !== undefined ? { output } : {}),
    ...(body.patches !== undefined ? { patches: body.patches } : {}),
    ...(typeof body.error === 'string' ? { error: body.error } : {})
  };
}

function normalizeWorkflowStatus(value: unknown): 'pending' | 'running' | 'success' | 'failure' {
  switch (value) {
    case 'pending':
    case 'queued':
    case 'starting':
    case 'created':
    case 'submitted':
    case 'dispatching':
      return 'pending';
    case 'running':
    case 'in_progress':
    case 'in-progress':
      return 'running';
    case 'success':
    case 'succeeded':
    case 'completed':
    case 'complete':
      return 'success';
    case 'failure':
    case 'failed':
    case 'cancelled':
    case 'canceled':
    case 'timed_out':
    case 'timeout':
    case 'timed-out':
      return 'failure';
    default:
      return 'pending';
  }
}

function normalizeWorkflowOutput(body: Record<string, unknown>): unknown {
  if (body.output !== undefined) return body.output;
  if (body.result !== undefined && body.patches !== undefined) {
    return { result: body.result, patches: body.patches };
  }
  if (body.result !== undefined) return body.result;
  if (body.patches !== undefined) return { patches: body.patches };
  return undefined;
}

function workflowHeaders(token: string, delegated: boolean): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    ...(delegated ? { [WORKFLOW_INVOCATION_HEADER]: 'true' } : {})
  };
}

async function workflowError(response: Response, label: string): Promise<Error> {
  const body = await response.text().catch(() => '');
  const excerpt = body.length > 400 ? `${body.slice(0, 400)}...` : body;
  return new WorkflowRequestError(
    `${label}: ${response.status} ${response.statusText}${excerpt ? ` - ${excerpt}` : ''}`,
    // Cloud workflow routes use 401 for missing/invalid/not-yet-propagated
    // tokens, and 403 only for valid tokens that lack scope or workspace
    // access. Retry 401 briefly for post-mint propagation; fail 403 fast so
    // scope/tenant misconfiguration is not hidden behind retry noise.
    response.status === 401 || response.status === 429 || response.status >= 500
  );
}

async function fetchWorkflow(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKFLOW_FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    const message = err instanceof Error && err.name === 'AbortError'
      ? `timeout after ${WORKFLOW_FETCH_TIMEOUT_MS}ms`
      : err instanceof Error ? err.message : String(err);
    throw new WorkflowRequestError(`workflow request failed: ${message}`, true);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createProcessHarnessRunner(args: CloudDefaultOptions & {
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
}): (run: HarnessRunArgs) => Promise<HarnessRunResult> {
  return async (run) => {
    // harness/model/systemPrompt are optional on the persona spec (pure
    // orchestrator handlers omit them). But a handler that actually calls
    // ctx.harness.run() needs all three to spawn the session — fail with a
    // pointed error rather than passing `undefined` into the spec builder.
    if (!args.persona.harness || !args.persona.model || args.persona.systemPrompt === undefined) {
      throw new Error(
        `ctx.harness.run() requires the persona to declare harness, model, and systemPrompt — ` +
          `persona "${args.persona.id}" omits ${[
            !args.persona.harness && 'harness',
            !args.persona.model && 'model',
            args.persona.systemPrompt === undefined && 'systemPrompt'
          ]
            .filter(Boolean)
            .join(', ')}. Add them to persona.json, or remove the ctx.harness.run() call.`
      );
    }
    const harness = args.persona.harness;
    const personaModel = args.persona.model;
    const personaSystemPrompt = args.persona.systemPrompt;

    const inputValues = resolveAgentInputValues(args.agent);
    const inputResolution = resolvePersonaInputs(args.persona.inputs, inputValues, args.env);
    const callerEnv = { ...args.env, ...inputResolution.values };
    const envResolution = resolveStringMapLenient(args.persona.env, callerEnv, 'env');
    const mcpResolution = resolveMcpServersLenient(args.persona.mcpServers, callerEnv);
    for (const warning of [
      ...envResolution.dropped.map((drop) => `${drop.field} dropped (env var ${drop.ref} is not set)`),
      ...mcpResolution.dropped.map((drop) => `${drop.field} dropped (env var ${drop.ref} is not set)`),
      ...mcpResolution.droppedServers.map((drop) =>
        `mcpServers.${drop.name} dropped entirely (required refs missing: ${drop.refs.join(', ')})`
      )
    ]) {
      args.log('warn', 'harness.config.dropped', { warning });
    }

    const renderedSystemPrompt = renderPersonaInputs(personaSystemPrompt, inputResolution.values);
    const cwd = resolveWorkspacePath(args.workspaceRoot, run.cwd ?? args.workspaceRoot);
    await assertDirectory(cwd);
    await materializeSidecar({
      persona: args.persona,
      inputValues: inputResolution.values,
      cwd,
      log: args.log
    });
    const task = run.prompt;
    const spec = buildNonInteractiveSpec({
      harness,
      personaId: args.persona.id,
      model: personaModel,
      systemPrompt: renderedSystemPrompt,
      harnessSettings: args.persona.harnessSettings,
      mcpServers: mcpResolution.servers,
      permissions: args.persona.permissions,
      task,
      name: args.persona.id,
      workingDirectory: cwd
    });
    for (const warning of spec.warnings) {
      args.log('warn', 'harness.spec.warning', { warning });
    }
    for (const file of spec.configFiles) {
      await writeWorkspaceRelativeFile(cwd, file.path, file.contents);
    }
    const startedAt = Date.now();
    const childEnv = {
      ...callerEnv,
      ...(envResolution.value ?? {}),
      ...inputResolution.values,
      ...(run.inputs ?? {}),
      ...(run.env ?? {}),
      WORKFORCE_PERSONA_ID: args.persona.id,
      WORKFORCE_AGENT_ID: args.agent.id,
      WORKFORCE_DEPLOYMENT_ID: args.deployment.id,
      WORKFORCE_WORKSPACE_ID: args.workspaceId
    };
    const result = await spawnAndCapture({
      bin: spec.bin,
      args: [...spec.args],
      cwd,
      env: childEnv,
      timeoutMs: args.persona.harnessSettings.timeoutSeconds
        ? args.persona.harnessSettings.timeoutSeconds * 1000
        : undefined
    });
    const parsed = extractUsage(result.output, result.stderr);
    const harnessResult: HarnessRunResult = {
      output: parsed.output.trimEnd(),
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      ...(parsed.usage ? { usage: parsed.usage } : {})
    };
    await reportHarnessUsage({
      result: harnessResult,
      persona: args.persona,
      agent: args.agent,
      deployment: args.deployment,
      workspaceId: args.workspaceId,
      env: args.env,
      log: args.log
    });
    return harnessResult;
  };
}

async function materializeSidecar(args: {
  persona: PersonaSpec;
  inputValues: Record<string, string>;
  cwd: string;
  log: WorkforceCtx['log'];
}): Promise<void> {
  const sidecar = sidecarForPersona(args.persona, args.inputValues);
  if (!sidecar) return;
  const target = resolveWorkspacePath(args.cwd, sidecar.file);
  let body = sidecar.content;
  if (sidecar.mode === 'extend') {
    try {
      const existing = await readFile(target, 'utf8');
      body = `${existing}\n\n---\n\n${sidecar.content}`;
    } catch (err) {
      if (!isNoEntry(err)) throw err;
    }
  }
  await writeWorkspaceRelativeFile(args.cwd, sidecar.file, body.endsWith('\n') ? body : `${body}\n`);
  args.log('debug', 'harness.sidecar.materialized', { file: sidecar.file, mode: sidecar.mode });
}

function sidecarForPersona(
  persona: PersonaSpec,
  inputValues: Record<string, string>
): { file: 'CLAUDE.md' | 'AGENTS.md'; content: string; mode: 'overwrite' | 'extend' } | undefined {
  if (persona.harness === 'claude' && persona.claudeMdContent) {
    return {
      file: 'CLAUDE.md',
      content: renderPersonaInputs(persona.claudeMdContent, inputValues),
      mode: persona.claudeMdMode ?? 'overwrite'
    };
  }
  if ((persona.harness === 'codex' || persona.harness === 'opencode') && persona.agentsMdContent) {
    return {
      file: 'AGENTS.md',
      content: renderPersonaInputs(persona.agentsMdContent, inputValues),
      mode: persona.agentsMdMode ?? 'overwrite'
    };
  }
  return undefined;
}

async function spawnAndCapture(args: {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ output: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(args.bin, args.args, {
      cwd: args.cwd,
      env: args.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });
    let stdout = '';
    let stderr = '';
    let forceKillTimeout: NodeJS.Timeout | undefined;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timeout =
      args.timeoutMs !== undefined
        ? setTimeout(() => {
            child.kill('SIGTERM');
            forceKillTimeout = setTimeout(() => child.kill('SIGKILL'), 1000);
          }, args.timeoutMs)
        : undefined;
    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
    };
    child.on('error', (err) => {
      clearTimers();
      resolve({ output: stdout, stderr: `${stderr}${err.message}\n`, exitCode: 1 });
    });
    child.on('close', (code, signal) => {
      clearTimers();
      resolve({
        output: stdout,
        stderr,
        exitCode: typeof code === 'number' ? code : signal ? signalExitCode(signal) : 1
      });
    });
  });
}

function signalExitCode(signal: NodeJS.Signals): number {
  const code = signal.startsWith('SIG') ? signalCode(signal.slice(3)) : undefined;
  return code ? 128 + code : 1;
}

function signalCode(name: string): number | undefined {
  const signals: Record<string, number> = {
    HUP: 1,
    INT: 2,
    QUIT: 3,
    ILL: 4,
    TRAP: 5,
    ABRT: 6,
    BUS: 7,
    FPE: 8,
    KILL: 9,
    USR1: 10,
    SEGV: 11,
    USR2: 12,
    PIPE: 13,
    ALRM: 14,
    TERM: 15
  };
  return signals[name];
}

function extractUsage(output: string, stderr: string): { output: string; usage?: HarnessUsage } {
  let usage: HarnessUsage | undefined;
  const cleaned = output
    .split(/\r?\n/)
    .filter((line) => {
      const parsed = parseUsageLine(line);
      if (parsed) {
        usage = parsed;
        return false;
      }
      return true;
    })
    .join('\n');
  if (!usage) {
    for (const line of stderr.split(/\r?\n/)) {
      const parsed = parseUsageLine(line);
      if (parsed) {
        usage = parsed;
        break;
      }
    }
  }
  return { output: cleaned, ...(usage ? { usage } : {}) };
}

function parseUsageLine(line: string): HarnessUsage | undefined {
  const trimmed = line.trim();
  const raw = trimmed.startsWith('WORKFORCE_USAGE_JSON=')
    ? trimmed.slice('WORKFORCE_USAGE_JSON='.length)
    : trimmed.startsWith('__WORKFORCE_USAGE__=')
      ? trimmed.slice('__WORKFORCE_USAGE__='.length)
      : undefined;
  if (!raw) return undefined;
  try {
    return normalizeUsage(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function normalizeUsage(value: unknown): HarnessUsage {
  if (!isRecord(value)) return { raw: value };
  const inputTokens = finiteNumber(value.inputTokens ?? value.input_tokens ?? value.promptTokens ?? value.prompt_tokens);
  const outputTokens = finiteNumber(value.outputTokens ?? value.output_tokens ?? value.completionTokens ?? value.completion_tokens);
  const totalTokens = finiteNumber(value.totalTokens ?? value.total_tokens);
  const costUsd = finiteNumber(value.costUsd ?? value.cost_usd);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(typeof value.provider === 'string' ? { provider: value.provider } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    raw: value
  };
}

async function reportHarnessUsage(args: {
  result: HarnessRunResult;
  persona: PersonaSpec;
  agent: WorkforceAgentContext;
  deployment: WorkforceDeploymentContext;
  workspaceId: string;
  env: NodeJS.ProcessEnv;
  log: WorkforceCtx['log'];
}): Promise<void> {
  const usageUrl = firstNonEmpty(args.env.WORKFORCE_USAGE_URL);
  const token = firstNonEmpty(args.env.WORKFORCE_DEPLOYMENT_TOKEN);
  if (!usageUrl || !token || !args.result.usage) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), USAGE_REPORT_TIMEOUT_MS);
  try {
    const response = await fetch(usageUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        workspaceId: args.workspaceId,
        deploymentId: args.deployment.id,
        agentId: args.agent.id,
        personaId: args.persona.id,
        harness: args.persona.harness,
        model: args.result.usage.model ?? args.persona.model,
        durationMs: args.result.durationMs,
        exitCode: args.result.exitCode,
        usage: args.result.usage
      })
    });
    if (!response.ok) {
      args.log('warn', 'harness.usage.report.failed', { status: response.status });
    }
  } catch (err) {
    args.log('warn', 'harness.usage.report.failed', {
      error: err instanceof Error && err.name === 'AbortError'
        ? `timeout after ${USAGE_REPORT_TIMEOUT_MS}ms`
        : err instanceof Error ? err.message : String(err)
    });
  } finally {
    clearTimeout(timer);
  }
}

function resolveWorkspacePath(root: string, inputPath: string): string {
  const normalizedRoot = path.resolve(root);
  const candidate = inputPath.startsWith(normalizedRoot)
    ? path.resolve(inputPath)
    : inputPath === '/workspace'
      ? normalizedRoot
      : inputPath.startsWith('/workspace/')
        ? path.resolve(normalizedRoot, inputPath.slice('/workspace/'.length))
        : inputPath.startsWith('/')
          ? path.resolve(normalizedRoot, inputPath.slice(1))
          : path.resolve(normalizedRoot, inputPath);
  const relative = path.relative(normalizedRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`sandbox path escapes workspace root: ${inputPath}`);
  }
  return candidate;
}

async function writeWorkspaceRelativeFile(root: string, relativePath: string, contents: string): Promise<void> {
  const target = resolveWorkspacePath(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
}

async function assertDirectory(dir: string): Promise<void> {
  const info = await stat(dir).catch(async (err) => {
    if (isNoEntry(err)) {
      await mkdir(dir, { recursive: true });
      return stat(dir);
    }
    throw err;
  });
  if (!info.isDirectory()) {
    throw new Error(`sandbox cwd is not a directory: ${dir}`);
  }
  await access(dir, constants.R_OK | constants.W_OK);
}

function resolveAgentInputValues(agent: AgentRowContext): Record<string, AgentInputValue> {
  return {
    ...(agent.inputValues ?? {}),
    ...(agent.input_values ?? {})
  };
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNoEntry(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
