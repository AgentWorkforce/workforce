import { resolveTrajectoryRecording, type PersonaSpec } from '@agentworkforce/persona-kit';
import type {
  LlmContext,
  MemoryContext,
  FilesContext,
  CredentialsContext,
  MemoryItem,
  RelayContext,
  RequiredRuntimeCredentials,
  ScheduleContext,
  SandboxContext,
  WorkforceAgentContext,
  WorkforceCtx,
  WorkforceDeploymentContext,
  WorkflowContext
} from './types.js';
import { attachTrajectoryRecorder, createTrajectoryRecorder } from './trajectory.js';
import { buildRelayContext } from './relay.js';

type AgentInputValue = string | number | boolean | null | undefined;

interface AgentRowContext extends WorkforceAgentContext {
  /**
   * Mirrors agents.input_values. These are agent-level values, not
   * per-deployment overrides.
   */
  input_values?: Record<string, AgentInputValue>;
  /** Camel-case alias for local callers that do not pass a raw DB row. */
  inputValues?: Record<string, AgentInputValue>;
}

/**
 * Options passed to `buildCtx` when the runner cold-starts. The deploy
 * package supplies these from the bundle metadata + environment.
 *
 * Required subsystems (`sandbox`, `harnessRunner`) must always be
 * provided — there is no sensible default for spawning a harness or
 * executing inside an isolated filesystem. Optional subsystems
 * (`llm`, `memory`, `workflow`, `schedule`, `log`, `integrations`)
 * fall back to documented defaults: `memory` becomes a cloud-backed
 * adapter when the sandbox env has enough auth, otherwise a no-op (so
 * `ctx.memory.save(...)` is safe to call from any handler), the rest
 * throw with a single-line "not configured" message that names the
 * persona-side flag a caller would set to enable them.
 */
export interface CtxBuildOptions {
  persona: PersonaSpec;
  workspaceId: string;
  agentName?: string;
  agent: AgentRowContext;
  deployment: WorkforceDeploymentContext;
  sandbox: SandboxContext;
  files?: FilesContext;
  llm?: LlmContext;
  memory?: MemoryContext;
  workflow?: WorkflowContext;
  schedule?: ScheduleContext;
  relay?: RelayContext;
  integrations?: Record<string, unknown>;
  log?: WorkforceCtx['log'];
  harnessRunner: WorkforceCtx['harness']['run'];
  /**
   * Root directory for per-run trajectory contract files. Defaults to
   * `env.TRAJECTORY_ROOT`; when neither resolves, trajectory recording is
   * disabled (the runtime never writes to the process cwd). The cloud runtime
   * sets this to the same value it passes to the injected ai-hist MCP so the
   * MCP reads back exactly what the runtime wrote.
   */
  trajectoryRoot?: string;
}

const NOOP_MEMORY: MemoryContext = {
  async save() {
    /* memory disabled (persona.memory unset) — saves silently no-op */
  },
  async recall() {
    return [];
  }
};

const DEFAULT_CLOUD_BASE_URL = 'https://agentrelay.com';
const MEMORY_HTTP_TIMEOUT_MS = 15_000;

const UNAVAILABLE_LLM: LlmContext = {
  async complete() {
    throw new Error(
      'ctx.llm is unavailable: set persona.useSubscription:true and connect a provider, or pass a workforce-billed LlmContext to buildCtx.'
    );
  }
};

const UNAVAILABLE_WORKFLOW: WorkflowContext = {
  async run() {
    throw new Error(
      'ctx.workflow is unavailable: the runner is not connected to the workforce workflows API (workspace token missing).'
    );
  },
  async status() {
    throw new Error(
      'ctx.workflow is unavailable: the runner is not connected to the workforce workflows API (workspace token missing).'
    );
  }
};

const UNAVAILABLE_SCHEDULE: ScheduleContext = {
  async at() {
    throw new Error(
      'ctx.schedule.at is unavailable: connect the runner to a scheduler (relaycron or workforce cloud) before scheduling follow-ups.'
    );
  },
  async cancel() {
    throw new Error(
      'ctx.schedule.cancel is unavailable: connect the runner to a scheduler (relaycron or workforce cloud) before canceling schedules.'
    );
  }
};

function defaultLog(level: string, message: string, attrs?: Record<string, unknown>): void {
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  const line = JSON.stringify({ t: new Date().toISOString(), level, message, ...(attrs ?? {}) });
  stream.write(`${line}\n`);
}

/**
 * Compose a WorkforceCtx from the deploy-supplied subsystems. Subsystems
 * left unset fall back to the documented defaults at the top of this
 * file — handlers that depend on an unavailable subsystem fail with a
 * clear runtime error rather than silently dropping work.
 */
export function buildCtx(options: CtxBuildOptions): WorkforceCtx {
  const { agent, deployment } = options;
  // Merge per key so a partial `input_values` (DB row) does not eclipse
  // keys only present in the camel-case `inputValues` alias. `input_values`
  // takes precedence on collisions to match the canonical DB shape.
  const mergedAgentInputValues: Record<string, AgentInputValue> = {
    ...(agent.inputValues ?? {}),
    ...(agent.input_values ?? {})
  };
  const log = options.log ?? defaultLog;
  const files = options.files ?? filesFromSandbox(options.sandbox);
  const agentName = options.agentName ?? options.persona.id;
  // Per-persona trajectory recorder (the WHY). Opt-in: no-op unless the
  // persona declares `memory.trajectories` AND a trajectory root resolves.
  const trajectory = resolveTrajectoryRecording(options.persona.memory);
  const trajectoryRecorder = createTrajectoryRecorder({
    personaId: options.persona.id,
    agentName,
    workspaceId: options.workspaceId,
    recordTrajectories: trajectory.enabled,
    ...(trajectory.autoCompact !== undefined ? { autoCompact: trajectory.autoCompact } : {}),
    ...(options.trajectoryRoot ? { trajectoryRoot: options.trajectoryRoot } : {}),
    log
  });
  const ctx: WorkforceCtx = {
    persona: buildPersonaContext(options.persona, mergedAgentInputValues),
    agent: {
      id: agent.id,
      deployedName: agent.deployedName,
      spawnedByAgentId: agent.spawnedByAgentId
    },
    deployment,
    workspaceId: options.workspaceId,
    agentName,
    llm: options.llm ?? UNAVAILABLE_LLM,
    harness: { run: options.harnessRunner },
    sandbox: options.sandbox,
    files,
    credentials: credentialsFromEnv(),
    memory: options.memory ?? defaultMemoryFor(options.persona.memory, options.workspaceId, log),
    workflow: options.workflow ?? UNAVAILABLE_WORKFLOW,
    schedule: options.schedule ?? UNAVAILABLE_SCHEDULE,
    relay: options.relay ?? buildRelayContext(log),
    trajectory: trajectoryRecorder.context,
    log
  };
  // The runner drives the recorder's lifecycle (begin/complete/fail) via this
  // non-enumerable handle, keeping those internals off the public ctx surface.
  attachTrajectoryRecorder(ctx, trajectoryRecorder);

  // Optional per-integration subsystems attach as named ctx fields. The
  // cloud-default runtime does not populate this — handlers read provider
  // data through the runtime's VFS helpers (listJsonFiles / readJsonFile /
  // writeJsonFile) against the provider path conventions. The passthrough
  // is kept so external callers can still inject custom clients when they
  // build their own ctx.
  //
  // Reserved fields are guarded so a malformed persona that declares
  // an integration named `harness` or `sandbox` cannot clobber core
  // ctx subsystems — that would silently turn `ctx.harness.run(...)`
  // into a call against an attacker-controlled object.
  if (options.integrations) {
    for (const [provider, client] of Object.entries(options.integrations)) {
      if (CORE_CTX_FIELDS.has(provider)) {
        throw new Error(
          `runtime: integration provider "${provider}" collides with a core ctx field; rename the integration in your persona JSON`
        );
      }
      Object.assign(ctx, { [provider]: client });
    }
  }

  return ctx;
}

const CORE_CTX_FIELDS: ReadonlySet<string> = new Set([
  'persona',
  'agent',
  'deployment',
  'workspaceId',
  'agentName',
  'llm',
  'harness',
  'sandbox',
  'files',
  'credentials',
  'memory',
  'workflow',
  'schedule',
  'relay',
  'trajectory',
  'log'
]);

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

function credentialsFromEnv(processEnv: NodeJS.ProcessEnv = process.env): CredentialsContext {
  return {
    get relayfile() {
      return requireRuntimeCredentials(processEnv).relayfile;
    },
    get cloudApi() {
      return requireRuntimeCredentials(processEnv).cloudApi;
    },
    tryRequire() {
      const snapshot = readRuntimeCredentialSnapshot(processEnv);
      return snapshot.missing.length > 0 ? null : snapshot.credentials;
    },
    require() {
      return requireRuntimeCredentials(processEnv);
    }
  };
}

function requireRuntimeCredentials(processEnv: NodeJS.ProcessEnv): RequiredRuntimeCredentials {
  const snapshot = readRuntimeCredentialSnapshot(processEnv);
  if (snapshot.missing.length > 0) {
    throw new Error(`Runtime credentials are required: missing ${snapshot.missing.join(', ')}`);
  }
  return snapshot.credentials;
}

function readRuntimeCredentialSnapshot(processEnv: NodeJS.ProcessEnv): {
  credentials: RequiredRuntimeCredentials;
  missing: string[];
} {
  const relayfileUrl = normalizeOptionalUrl(firstNonEmpty(processEnv.RELAYFILE_URL));
  const relayfileToken = firstNonEmpty(processEnv.RELAYFILE_TOKEN);
  const relayfileWorkspaceId = firstNonEmpty(processEnv.RELAYFILE_WORKSPACE_ID);
  const cloudApiUrl = normalizeOptionalUrl(firstNonEmpty(processEnv.CLOUD_API_URL));
  const cloudApiToken = firstNonEmpty(processEnv.CLOUD_API_ACCESS_TOKEN);
  const missing = [
    ...(!relayfileUrl ? ['relayfile.url'] : []),
    ...(!relayfileToken ? ['relayfile.token'] : []),
    ...(!relayfileWorkspaceId ? ['relayfile.workspaceId'] : []),
    ...(!cloudApiUrl ? ['cloudApi.url'] : []),
    ...(!cloudApiToken ? ['cloudApi.token'] : [])
  ];

  return {
    credentials: {
      relayfile: {
        url: relayfileUrl ?? '',
        token: relayfileToken ?? '',
        workspaceId: relayfileWorkspaceId ?? ''
      },
      cloudApi: {
        url: cloudApiUrl ?? '',
        token: cloudApiToken ?? ''
      }
    },
    missing
  };
}

function normalizeOptionalUrl(value: string | undefined): string | undefined {
  return value ? normalizeBaseUrl(value) : undefined;
}

function defaultMemoryFor(
  memoryConfig: PersonaSpec['memory'],
  workspaceId: string,
  log: WorkforceCtx['log'],
  processEnv: NodeJS.ProcessEnv = process.env
): MemoryContext {
  if (
    memoryConfig === false ||
    memoryConfig === undefined ||
    (typeof memoryConfig === 'object' && memoryConfig !== null && 'enabled' in memoryConfig && memoryConfig.enabled === false)
  ) {
    return NOOP_MEMORY;
  }
  const cloudBaseUrl = firstNonEmpty(
    processEnv.WORKFORCE_CLOUD_URL,
    processEnv.WORKFORCE_DEPLOY_CLOUD_URL,
    processEnv.AGENTRELAY_CLOUD_URL
  ) ?? DEFAULT_CLOUD_BASE_URL;
  const agentToken = resolveAgentToken(processEnv);
  const resolvedWorkspaceId = firstNonEmpty(
    processEnv.WORKFORCE_WORKSPACE_ID,
    processEnv.RELAY_WORKSPACE_ID,
    processEnv.RELAY_DEFAULT_WORKSPACE,
    workspaceId
  ) ?? workspaceId;
  if (!agentToken || !resolvedWorkspaceId) return NOOP_MEMORY;
  return createCloudMemoryContext({
    cloudBaseUrl,
    workspaceId: resolvedWorkspaceId,
    agentToken,
    log
  });
}

function createCloudMemoryContext(args: {
  cloudBaseUrl: string;
  workspaceId: string;
  agentToken: string;
  log: WorkforceCtx['log'];
}): MemoryContext {
  const endpoint = new URL(
    `${normalizeBaseUrl(args.cloudBaseUrl)}/api/v1/workspaces/${encodeURIComponent(args.workspaceId)}/memory`
  );
  return {
    async save(content, opts) {
      try {
        const response = await fetchWithTimeout(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${args.agentToken}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            scope: opts?.scope ?? 'workspace',
            content,
            ...(opts?.tags ? { tags: opts.tags } : {}),
            ...memoryTtl(opts)
          })
        });
        if (!response.ok) {
          args.log('warn', 'memory.save.failed', { status: response.status });
          return undefined;
        }
        const body = await response.json().catch(() => ({})) as { id?: unknown };
        return typeof body.id === 'string' ? { id: body.id } : undefined;
      } catch (err) {
        args.log('warn', 'memory.save.failed', { error: memoryFetchErrorMessage(err) });
        return undefined;
      }
    },
    async recall(query, opts) {
      try {
        const url = new URL(endpoint);
        url.searchParams.set('scope', opts?.scope ?? opts?.scopes?.[0] ?? 'workspace');
        url.searchParams.set('query', query);
        if (opts?.limit !== undefined) url.searchParams.set('limit', String(opts.limit));
        if (opts?.tags?.length) url.searchParams.set('tags', opts.tags.join(','));
        const response = await fetchWithTimeout(url, {
          headers: { authorization: `Bearer ${args.agentToken}` }
        });
        if (!response.ok) {
          args.log('warn', 'memory.recall.failed', { status: response.status });
          return [];
        }
        const body = await response.json().catch(() => ({})) as { items?: unknown };
        return normalizeMemoryItems(body.items);
      } catch (err) {
        args.log('warn', 'memory.recall.failed', { error: memoryFetchErrorMessage(err) });
        return [];
      }
    }
  };
}

async function fetchWithTimeout(input: URL | string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEMORY_HTTP_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function memoryFetchErrorMessage(error: unknown): string {
  if (isAbortError(error)) return `timeout after ${MEMORY_HTTP_TIMEOUT_MS}ms`;
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function memoryTtl(opts: Parameters<MemoryContext['save']>[1]): { ttlSeconds?: number } {
  if (typeof opts?.ttlSeconds === 'number' && Number.isFinite(opts.ttlSeconds) && opts.ttlSeconds > 0) {
    return { ttlSeconds: Math.ceil(opts.ttlSeconds) };
  }
  if (typeof opts?.expiresInMs === 'number' && Number.isFinite(opts.expiresInMs) && opts.expiresInMs > 0) {
    return { ttlSeconds: Math.ceil(opts.expiresInMs / 1000) };
  }
  return {};
}

function normalizeMemoryItems(value: unknown): MemoryItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.content !== 'string') return [];
    const scope = record.scope === 'user' || record.scope === 'global' ? record.scope : 'workspace';
    return [{
      id: record.id,
      content: record.content,
      tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      scope,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : ''
    }];
  });
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function resolveAgentToken(processEnv: NodeJS.ProcessEnv): string | undefined {
  return firstNonEmpty(
    processEnv.WORKFORCE_AGENT_TOKEN,
    processEnv.RELAY_AGENT_TOKEN,
    processEnv.RELAYFILE_TOKEN,
    tokenFromAgentTokenMap(processEnv.RELAY_AGENT_TOKENS, processEnv.RELAY_AGENT_NAME),
    processEnv.RELAY_API_KEY,
    processEnv.WORKFORCE_WORKSPACE_TOKEN
  );
}

function tokenFromAgentTokenMap(raw: string | undefined, agentName: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!value.startsWith('{')) return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const tokens = parsed as Record<string, unknown>;
    const namedToken = agentName ? tokens[agentName] : undefined;
    if (typeof namedToken === 'string' && namedToken.trim()) return namedToken.trim();
    const singleToken = Object.values(tokens).find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    return singleToken?.trim();
  } catch {
    return undefined;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function buildPersonaContext(
  persona: PersonaSpec,
  agentInputValues: Record<string, AgentInputValue> | undefined,
  processEnv: NodeJS.ProcessEnv = process.env
): WorkforceCtx['persona'] {
  const inputSpecs = persona.inputs ?? {};
  const inputs: Record<string, string> = {};

  for (const [key, spec] of Object.entries(inputSpecs)) {
    // Mirror the canonical resolution chain used by persona-kit's
    // `resolvePersonaInputs`: agent-provided value → process env
    // (`spec.env` or the input key) → spec default. Empty strings are
    // treated as "missing" so they fall through to later tiers, matching
    // persona-kit so the runtime and CLI/plan paths stay in lockstep.
    const envName = spec.env ?? key;
    const agentValue = stringifyInputValue(agentInputValues?.[key]);
    const envValue = stringifyInputValue(processEnv[envName]);
    const defaultValue = stringifyInputValue(spec.default);
    const resolved = agentValue ?? envValue ?? defaultValue;
    if (resolved === undefined) {
      if (spec.optional) {
        inputs[key] = '';
        continue;
      }
      throw new Error(
        `Required input '${key}' has no value (no deployment override, no spec default). Set it via 'workforce deploy --input <key>=<value>' or by editing the agent record.`
      );
    }
    inputs[key] = resolved;
  }

  return {
    ...persona,
    inputs,
    inputSpecs
  };
}

function stringifyInputValue(value: AgentInputValue): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value);
  return text === '' ? undefined : text;
}
