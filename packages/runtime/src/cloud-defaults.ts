import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { accessSync, statSync } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildNonInteractiveSpec,
  renderPersonaInputs,
  resolveAiMemory,
  resolveMcpServersLenient,
  resolvePersonaInputs,
  resolveStringMapLenient,
  type AiHistMcpConfig,
  type PersonaSpec,
  type RelayMcpConfig
} from '@agentworkforce/persona-kit';
import { createDefaultLlm } from './cloud-llm.js';
import { SandboxNotAvailableError } from './errors.js';
import type {
  FilesContext,
  HarnessRunArgs,
  HarnessRunResult,
  HarnessUsage,
  LlmContext,
  SandboxContext,
  WorkforceAgentContext,
  WorkforceCtx,
  WorkforceDeploymentContext,
  WorkflowContext
} from './types.js';

type AgentInputValue = string | number | boolean | null | undefined;
const USAGE_REPORT_TIMEOUT_MS = 5_000;
const WORKFLOW_COMPLETION_POLL_MS = 1_000;
const WORKFLOW_COMPLETION_TIMEOUT_MS = 90 * 60_000;
const WORKFLOW_FETCH_TIMEOUT_MS = 15_000;
const WORKFLOW_COMPLETION_MAX_TRANSIENT_ERRORS = 3;
const WORKFLOW_INVOCATION_HEADER = 'x-agentworkforce-workspace-workflow-invocation';

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
  workflow?: WorkflowContext;
  llm?: LlmContext;
  harnessRunner: (args: HarnessRunArgs) => Promise<HarnessRunResult>;
  /**
   * Resolved trajectory root for this deployment, or `undefined` when there is
   * no cloud workspace and `TRAJECTORY_ROOT` is unset (local/tests stay opt-in,
   * so the runtime never writes to a developer's cwd). The runner threads this
   * into `buildCtx` as the recorder write-root; the harness spec passes the
   * same value to the ai-hist MCP — that single source keeps write-root and
   * MCP-root identical.
   */
  trajectoryRoot?: string;
}

export function createCloudRuntimeDefaults(options: CloudDefaultOptions): CloudRuntimeDefaults {
  const env = options.env ?? process.env;
  const root = resolveCloudWorkspaceRoot(env);
  // Single source of truth for the trajectory root, computed once. Both the
  // recorder write-root (threaded into buildCtx by the runner) and the ai-hist
  // MCP env (in the harness spec) consume this exact value.
  const trajectoryRoot = resolveCloudTrajectoryRoot(env, root);
  const isSandboxOptional = options.persona.sandbox === false;
  const baseSandbox = createProcessSandbox(root, env);
  const sandbox = isSandboxOptional
    ? createSandboxOptionalSandbox(baseSandbox)
    : baseSandbox;
  const files = filesFromSandbox(baseSandbox);
  const workflow = createDefaultWorkflow({
    workspaceRoot: root,
    env
  });
  // ctx.llm from sandbox credentials — without this, no cloud persona ever
  // gets a working ctx.llm (buildCtx falls back to a throwing stub).
  const llm = createDefaultLlm({
    persona: options.persona,
    env,
    log: options.log
  });
  return {
    sandbox,
    files,
    ...(workflow ? { workflow } : {}),
    ...(llm ? { llm } : {}),
    ...(trajectoryRoot ? { trajectoryRoot } : {}),
    harnessRunner: createProcessHarnessRunner({
      ...options,
      workspaceRoot: root,
      env,
      trajectoryRoot
    })
  };
}

/**
 * Resolve the trajectory root for a cloud deployment. An explicit
 * `TRAJECTORY_ROOT` always wins. Otherwise it defaults to
 * `<workspaceRoot>/.trajectories` — but ONLY in a real cloud workspace
 * (configured mount or an accessible `/workspace`), so local/test runs stay
 * opt-in via env and never write to a developer's cwd.
 */
function resolveCloudTrajectoryRoot(env: NodeJS.ProcessEnv, workspaceRoot: string): string | undefined {
  const explicit = env.TRAJECTORY_ROOT?.trim();
  if (explicit) return explicit;
  const hasCloudWorkspace =
    firstNonEmpty(
      env.WORKFORCE_SANDBOX_ROOT,
      env.WORKFORCE_WORKSPACE_DIR,
      env.RELAYFILE_MOUNT_ROOT,
      env.RELAYFILE_ROOT
    ) !== undefined || canAccessSync('/workspace');
  return hasCloudWorkspace ? path.join(workspaceRoot, '.trajectories') : undefined;
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

/**
 * Wraps a base SandboxContext for personas that declared `sandbox: false`.
 * `exec()` rejects with `SandboxNotAvailableError` so `.catch(...)` chains
 * see it; `readFile`/`writeFile` delegate to the base sandbox so VFS reads
 * and writes still work without modification.
 */
function createSandboxOptionalSandbox(base: SandboxContext): SandboxContext {
  return {
    cwd: base.cwd,
    async exec() {
      throw new SandboxNotAvailableError();
    },
    readFile(filePath) {
      return base.readFile(filePath);
    },
    writeFile(filePath, contents) {
      return base.writeFile(filePath, contents);
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
  trajectoryRoot?: string;
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
    const task = run.prompt;
    const relayMcp = resolveRelayMcpFromEnv(args.env);
    // Inject the ai-hist MCP (the "why" + "how" retrieval surface) only when the
    // persona opts into recall via `memory.aiMemory` (off by default).
    // resolveAiHistFromEnv keys off the SAME TRAJECTORY_ROOT the runtime recorder
    // writes to, so the MCP reads back exactly what this deployment wrote.
    const aiMemory = resolveAiMemory(args.persona.memory);
    const aiHist = aiMemory.enabled
      ? resolveAiHistFromEnv(args.env, args.trajectoryRoot, aiMemory.dbPath)
      : undefined;
    const specInput = {
      harness,
      personaId: args.persona.id,
      model: personaModel,
      systemPrompt: renderedSystemPrompt,
      harnessSettings: args.persona.harnessSettings,
      mcpServers: mcpResolution.servers,
      permissions: args.persona.permissions,
      task,
      name: args.persona.id,
      workingDirectory: cwd,
      ...(aiHist ? { aiHist } : {})
    };
    const brokerRelayHarness = relayMcp && (harness === 'claude' || harness === 'codex');
    let spec = buildNonInteractiveSpec({
      ...specInput,
      ...(relayMcp && !brokerRelayHarness ? { relayMcp } : {})
    });
    let spawnArgs = [...spec.args];
    if (relayMcp && harness === 'codex') {
      const brokerMcpArgs = await resolveAgentRelayBrokerMcpArgs({
        cli: 'codex',
        env: args.env,
        relayMcp,
        cwd,
        existingArgs: codexExistingArgs(spawnArgs),
        log: args.log
      });
      if (brokerMcpArgs) {
        spawnArgs = injectCodexSubcommandArgs(spawnArgs, brokerMcpArgs);
      } else {
        // Legacy compatibility fallback. The broker's `agent-relay` MCP server
        // is preferred for Codex because `mcp-args --register` pre-mints
        // RELAY_AGENT_TOKEN and sets RELAY_SKIP_BOOTSTRAP=1; the older
        // `@relaycast/mcp` server self-registers during MCP initialize.
        spec = buildNonInteractiveSpec({ ...specInput, relayMcp });
        spawnArgs = [...spec.args];
      }
    } else if (relayMcp && harness === 'claude') {
      if (claudeMcpConfigHasRelayOverride(spawnArgs)) {
        args.log('debug', 'harness.relay_mcp.persona_override', {
          harness,
          serverNames: relayOverrideServerNames(spawnArgs)
        });
      } else {
        const brokerMcpArgs = await resolveAgentRelayBrokerMcpArgs({
          cli: 'claude',
          env: args.env,
          relayMcp,
          cwd,
          // Claude persona specs already contain --mcp-config; the broker
          // treats that as user-managed MCP and returns no injection args.
          // Ask for the canonical broker payload, then merge agent-relay into
          // the persona's strict config below.
          existingArgs: [],
          log: args.log
        });
        const mergedArgs = brokerMcpArgs
          ? injectClaudeAgentRelayMcpConfig(spawnArgs, brokerMcpArgs, args.log)
          : undefined;
        if (mergedArgs) {
          spawnArgs = mergedArgs;
        } else {
          // Legacy compatibility fallback. The broker-generated `agent-relay`
          // MCP server is preferred because it comes from the Relay SDK broker
          // helper and carries the pre-registered token fast path; the older
          // `@relaycast/mcp` server self-registers during MCP initialize.
          spec = buildNonInteractiveSpec({ ...specInput, relayMcp });
          spawnArgs = [...spec.args];
        }
      }
    }
    for (const warning of spec.warnings) {
      args.log('warn', 'harness.spec.warning', { warning });
    }
    for (const file of spec.configFiles) {
      await writeWorkspaceRelativeFile(cwd, file.path, file.contents);
    }
    await materializeSidecar({
      persona: args.persona,
      inputValues: inputResolution.values,
      cwd,
      log: args.log
    });
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
      args: spawnArgs,
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

interface BrokerMcpArgsOutput {
  args: string[];
  sideEffectFiles?: string[];
  agentToken?: string | null;
}

function resolveRelayMcpFromEnv(env: NodeJS.ProcessEnv): RelayMcpConfig | undefined {
  const apiKey = env.RELAY_API_KEY?.trim();
  const agentName = env.RELAY_AGENT_NAME?.trim();
  if (!apiKey || !agentName) return undefined;
  const baseUrl = env.RELAY_BASE_URL?.trim();
  const defaultWorkspace = env.RELAY_DEFAULT_WORKSPACE?.trim();
  return {
    apiKey,
    agentName,
    ...(baseUrl ? { baseUrl } : {}),
    ...(defaultWorkspace ? { defaultWorkspace } : {})
  };
}

/**
 * Resolve the ai-hist MCP config. Only called when the persona opts into recall
 * via `memory.aiMemory`. The "why" read-root mirrors the runtime recorder's
 * write-root (env `TRAJECTORY_ROOT` wins, else the deployment default), so the
 * MCP reads back exactly what the recorder wrote. The "how" DB comes from the
 * persona's `memory.aiMemory.dbPath` override, else `AI_HIST_DB` env.
 */
function resolveAiHistFromEnv(
  env: NodeJS.ProcessEnv,
  defaultTrajectoryRoot?: string,
  dbPathOverride?: string
): AiHistMcpConfig | undefined {
  // env.TRAJECTORY_ROOT wins; otherwise the deployment default (same value the
  // recorder writes to) — keeps the MCP read-root identical to the write-root.
  const trajectoryRoot = env.TRAJECTORY_ROOT?.trim() || defaultTrajectoryRoot;
  const dbPath = dbPathOverride?.trim() || env.AI_HIST_DB?.trim();
  return {
    ...(trajectoryRoot ? { trajectoryRoot } : {}),
    ...(dbPath ? { dbPath } : {})
  };
}

async function resolveAgentRelayBrokerMcpArgs(args: {
  cli: 'claude' | 'codex';
  env: NodeJS.ProcessEnv;
  relayMcp: RelayMcpConfig;
  cwd: string;
  existingArgs: string[];
  log: WorkforceCtx['log'];
}): Promise<string[] | undefined> {
  const broker = resolveAgentRelayBrokerBinary(args.env);
  const brokerArgs = [
    'mcp-args',
    '--cli',
    args.cli,
    '--agent-name',
    args.relayMcp.agentName,
    '--api-key',
    args.relayMcp.apiKey,
    ...(args.relayMcp.baseUrl ? ['--base-url', args.relayMcp.baseUrl] : []),
    '--register',
    '--cwd',
    args.cwd,
    '--existing-args',
    JSON.stringify(args.existingArgs)
  ];
  const workspacesJson = args.env.RELAY_WORKSPACES_JSON?.trim();
  if (workspacesJson) brokerArgs.push('--workspaces-json', workspacesJson);
  if (args.relayMcp.defaultWorkspace) {
    brokerArgs.push('--default-workspace', args.relayMcp.defaultWorkspace);
  }

  const result = await spawnAndCapture({
    bin: broker,
    args: brokerArgs,
    cwd: args.cwd,
    env: args.env,
    timeoutMs: 15_000
  });
  if (result.exitCode !== 0) {
    args.log('warn', 'harness.relay_mcp.broker_args_failed', {
      broker,
      exitCode: result.exitCode,
      stderr: redactRelayBrokerOutput(result.stderr.trim(), args.relayMcp)
    });
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.output);
  } catch (err) {
    args.log('warn', 'harness.relay_mcp.broker_args_invalid_json', {
      broker,
      error: err instanceof Error ? err.message : String(err)
    });
    return undefined;
  }
  if (!isBrokerMcpArgsOutput(parsed) || parsed.args.length === 0) {
    args.log('warn', 'harness.relay_mcp.broker_args_invalid_shape', { broker });
    return undefined;
  }
  if (parsed.sideEffectFiles?.length) {
    args.log('debug', 'harness.relay_mcp.side_effect_files', {
      files: parsed.sideEffectFiles
    });
  }
  return parsed.args;
}

function resolveAgentRelayBrokerBinary(env: NodeJS.ProcessEnv): string {
  const configured = env.AGENT_RELAY_BIN?.trim() || env.BROKER_BINARY_PATH?.trim();
  if (configured) return configured;
  const sandboxBroker = resolveSandboxAgentRelayBrokerBinary();
  return sandboxBroker ?? 'agent-relay-broker';
}

function resolveSandboxAgentRelayBrokerBinary(): string | undefined {
  const suffix = agentRelayBrokerPlatformSuffix();
  if (!suffix) return undefined;
  // Daytona cloud images install the Relay SDK smoke dependency here. This is
  // a compatibility fallback; env overrides and PATH remain the general SDK
  // contract for locating agent-relay-broker.
  const candidate = path.join(
    '/opt/relay-smoke/node_modules/@agent-relay/sdk/bin',
    `agent-relay-broker-${suffix}`
  );
  return canExecuteFileSync(candidate) ? candidate : undefined;
}

function agentRelayBrokerPlatformSuffix(): string | undefined {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : undefined;
  if (!arch) return undefined;
  if (process.platform === 'linux') return `linux-${arch}`;
  if (process.platform === 'darwin') return `darwin-${arch}`;
  if (process.platform === 'win32') return 'win32-x64.exe';
  return undefined;
}

function canExecuteFileSync(candidate: string): boolean {
  try {
    accessSync(candidate, constants.R_OK | constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function codexExistingArgs(args: string[]): string[] {
  return args[0] === 'exec' ? args.slice(1, -1) : [...args];
}

function redactRelayBrokerOutput(value: string, relayMcp: RelayMcpConfig): string {
  let redacted = value;
  for (const secret of [relayMcp.apiKey]) {
    if (secret) redacted = redacted.replaceAll(secret, '[REDACTED]');
  }
  return redacted;
}

function injectCodexSubcommandArgs(args: string[], injected: string[]): string[] {
  if (args[0] === 'exec') return ['exec', ...injected, ...args.slice(1)];
  if (args.length === 0 || args[0]?.startsWith('-')) return [...injected, ...args];
  return [...args];
}

function injectClaudeAgentRelayMcpConfig(
  args: string[],
  injected: string[],
  log: WorkforceCtx['log']
): string[] | undefined {
  const base = parseClaudeMcpConfigArg(args);
  const broker = parseClaudeMcpConfigArg(injected);
  if (!base || !broker) {
    log('warn', 'harness.relay_mcp.claude_mcp_config_missing');
    return undefined;
  }
  const baseServers = readMcpServersRecord(base.payload);
  const brokerServers = readMcpServersRecord(broker.payload);
  const agentRelay = brokerServers?.['agent-relay'];
  if (!baseServers || !brokerServers || agentRelay === undefined) {
    log('warn', 'harness.relay_mcp.claude_mcp_config_invalid');
    return undefined;
  }
  const mergedServers: Record<string, unknown> = {
    ...baseServers,
    'agent-relay': agentRelay
  };
  delete mergedServers.relaycast;
  const nextPayload = {
    ...base.payload,
    mcpServers: mergedServers
  };
  const next = [...args];
  next[base.valueIndex] = JSON.stringify(nextPayload);
  return next;
}

function claudeMcpConfigHasRelayOverride(args: string[]): boolean {
  return relayOverrideServerNames(args).length > 0;
}

function relayOverrideServerNames(args: string[]): string[] {
  const parsed = parseClaudeMcpConfigArg(args);
  const servers = parsed ? readMcpServersRecord(parsed.payload) : undefined;
  if (!servers) return [];
  return ['agent-relay', 'relaycast'].filter((name) => servers[name] !== undefined);
}

function parseClaudeMcpConfigArg(
  args: string[]
): { valueIndex: number; payload: Record<string, unknown> } | undefined {
  const flagIndex = args.indexOf('--mcp-config');
  if (flagIndex < 0) return undefined;
  const valueIndex = flagIndex + 1;
  const raw = args[valueIndex];
  if (typeof raw !== 'string') return undefined;
  try {
    const payload = JSON.parse(raw);
    return isRecord(payload) ? { valueIndex, payload } : undefined;
  } catch {
    return undefined;
  }
}

function readMcpServersRecord(
  payload: Record<string, unknown>
): Record<string, unknown> | undefined {
  const servers = payload.mcpServers;
  return isRecord(servers) ? servers : undefined;
}

function isBrokerMcpArgsOutput(value: unknown): value is BrokerMcpArgsOutput {
  if (!isRecord(value) || !Array.isArray(value.args)) return false;
  if (!value.args.every((arg) => typeof arg === 'string')) return false;
  if (
    value.sideEffectFiles !== undefined &&
    (!Array.isArray(value.sideEffectFiles) ||
      !value.sideEffectFiles.every((file) => typeof file === 'string'))
  ) {
    return false;
  }
  return value.agentToken === undefined ||
    value.agentToken === null ||
    typeof value.agentToken === 'string';
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
  if (
    (persona.harness === 'codex' ||
      persona.harness === 'opencode' ||
      persona.harness === 'grok' ||
      persona.harness === 'cursor') &&
    persona.agentsMdContent
  ) {
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
