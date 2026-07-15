import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { EventFrameV1 } from '@agentworkforce/events';
import { bindPreviewTransport, PreviewTransport, type TransportPreviewAction } from '@relayfile/relay-helpers';
import { buildCtx } from './ctx.js';
import { envelopeToAgentEvent } from './to-agent-event.js';
import type { RawGatewayEnvelope } from './shim.js';
import type {
  EffectPolicyV1,
  PreviewAction,
  RunRecordV2,
  RunRequestV1,
  RunTraceEventV1
} from './run-contracts.js';
import type {
  FilesContext,
  MemoryContext,
  MemoryItem,
  RelayContext,
  SandboxContext,
  ScheduleContext,
  WorkflowContext,
  WorkforceCtx,
  WorkforceHandler
} from './types.js';

export interface LocalHttpFixture {
  method: string;
  match: string;
  body: string;
  contentType?: string;
  sourcePath?: string;
}

export interface LocalPreviewMemoryEntry extends MemoryItem {
  scope: 'workspace' | 'user' | 'global';
}

export interface LocalPreviewState {
  files?: Record<string, string>;
  memory?: LocalPreviewMemoryEntry[];
}

export interface ExecuteLocalRunOptions {
  request: RunRequestV1;
  bundlePath: string;
  sourcePath?: string;
  inputs?: Record<string, string>;
  state?: LocalPreviewState;
  httpFixtures?: readonly LocalHttpFixture[];
  replayProvenance?: Record<string, unknown>;
  now?: () => Date;
}

export interface ExecuteLocalRunResult {
  record: RunRecordV2;
  exitCode: 0 | 1;
  logs: string[];
  state: LocalPreviewState;
}

const FORBIDDEN_NODE_IMPORTS = [
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
  'node:dgram',
  'node:child_process'
] as const;

export async function executeLocalRun(
  options: ExecuteLocalRunOptions
): Promise<ExecuteLocalRunResult> {
  const now = options.now ?? (() => new Date());
  if (options.sourcePath) {
    const sourceText = await readFile(options.sourcePath, 'utf8');
    for (const specifier of FORBIDDEN_NODE_IMPORTS) {
      const exactImport = new RegExp(`['"]${escapeRegExp(specifier)}['"]`);
      if (exactImport.test(sourceText)) {
        throw new Error(`invoke: preview bundles may not import ${specifier}`);
      }
    }
  }

  const actions: PreviewAction[] = [];
  const traces: RunTraceEventV1[] = [];
  const logs: string[] = [];
  const files = new Map<string, string>(Object.entries(options.state?.files ?? {}));
  const memory = [...(options.state?.memory ?? [])];
  const filesBefore = new Map(files);
  const runId = `run_local_${randomUUID()}`;
  let traceSeq = 0;
  let relaySeq = 0;
  let memorySeq = 0;
  let workflowSeq = 0;
  let scheduleSeq = 0;

  const trace = (
    phase: RunTraceEventV1['phase'],
    status: RunTraceEventV1['status'],
    summary: string,
    kind: string,
    data?: Record<string, unknown>
  ): void => {
    traces.push({
      schemaVersion: 1,
      seq: ++traceSeq,
      at: now().toISOString(),
      runId,
      spanId: `${runId}_span_${traceSeq}`,
      kind,
      phase,
      status,
      summary,
      ...(data ? { data } : {})
    });
  };

  const pushAction = (action: PreviewAction): void => {
    actions.push(action);
    trace(
      action.kind === 'provider.write' ? 'write' : action.kind === 'provider.read' ? 'read' : action.kind === 'model.complete' ? 'model' : action.kind.startsWith('compose.') ? 'compose' : 'result',
      action.status === 'denied' ? 'denied' : action.status === 'previewed' ? 'previewed' : 'succeeded',
      action.kind,
      action.kind,
      action.data
    );
  };

  const log: WorkforceCtx['log'] = (level, message, attrs) => {
    const payload = { t: now().toISOString(), level, message, ...(attrs ?? {}) };
    logs.push(JSON.stringify(payload));
  };

  const sandbox: SandboxContext = {
    cwd: '/preview',
    async exec(cmd) {
      if (options.request.policy.shell === 'deny') {
        pushAction({
          kind: 'shell.exec',
          status: 'denied',
          data: { cmd }
        });
        throw new Error(`invoke policy denied shell execution: ${cmd}`);
      }
      pushAction({
        kind: 'shell.exec',
        status: 'previewed',
        data: { cmd }
      });
      return { output: '', exitCode: 0 };
    },
    async readFile(path) {
      const value = files.get(path);
      if (value === undefined) throw new Error(`preview file not found: ${path}`);
      return value;
    },
    async writeFile(path, contents) {
      files.set(path, contents);
      pushAction({
        kind: 'files.write',
        status: 'previewed',
        data: { path, bytes: contents.length }
      });
    }
  };

  const fileCtx: FilesContext = {
    async read(path) {
      const value = files.get(path);
      if (value === undefined) throw new Error(`preview file not found: ${path}`);
      return value;
    },
    async write(path, contents) {
      files.set(path, contents);
      pushAction({
        kind: 'files.write',
        status: 'previewed',
        data: { path, bytes: contents.length }
      });
    }
  };

  const memoryCtx: MemoryContext = {
    async save(content, opts) {
      const entry: LocalPreviewMemoryEntry = {
        id: `mem_${++memorySeq}`,
        content,
        tags: [...(opts?.tags ?? [])],
        scope: opts?.scope ?? 'workspace',
        createdAt: now().toISOString()
      };
      memory.push(entry);
      pushAction({
        kind: 'memory.save',
        status: 'previewed',
        data: {
          id: entry.id,
          scope: entry.scope,
          tags: entry.tags
        }
      });
      return { id: entry.id };
    },
    async recall(_query, opts) {
      const scope = opts?.scope ?? opts?.scopes?.[0] ?? 'workspace';
      const tags = new Set(opts?.tags ?? []);
      const filtered = memory
        .filter((entry) => entry.scope === scope)
        .filter((entry) => tags.size === 0 || entry.tags.some((tag) => tags.has(tag)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const limited = filtered.slice(0, opts?.limit ?? filtered.length);
      pushAction({
        kind: 'memory.recall',
        status: 'previewed',
        data: {
          scope,
          tags: [...tags],
          items: limited.length
        }
      });
      return limited;
    }
  };

  const llm = {
    async complete(prompt: string) {
      const output = stubModelOutput(prompt);
      pushAction({
        kind: 'model.complete',
        status: 'previewed',
        data: {
          mode: options.request.policy.model,
          promptChars: prompt.length,
          outputChars: output.length
        }
      });
      return output;
    }
  };

  const workflow: WorkflowContext = {
    async run(name, args) {
      if (options.request.policy.compose === 'deny') {
        pushAction({
          kind: 'compose.run',
          status: 'denied',
          data: { name, args }
        });
        throw new Error(`invoke policy denied workflow.run("${name}")`);
      }
      const workflowRunId = `wf_${++workflowSeq}`;
      pushAction({
        kind: 'compose.run',
        status: 'previewed',
        data: { name, args, runId: workflowRunId }
      });
      return {
        runId: workflowRunId,
        async completion() {
          return { output: null, status: 'success' as const };
        }
      };
    },
    async status(runId) {
      pushAction({
        kind: 'compose.status',
        status: 'previewed',
        data: { runId, status: 'success' }
      });
      return { status: 'success' as const };
    }
  };

  const schedule: ScheduleContext = {
    async at(when, payload) {
      pushAction({
        kind: 'schedule.at',
        status: 'previewed',
        data: { id: `schedule_${++scheduleSeq}`, when: when.toISOString(), payload }
      });
    },
    async cancel(name) {
      pushAction({
        kind: 'schedule.cancel',
        status: 'previewed',
        data: { name }
      });
    }
  };

  const relay: RelayContext = {
    async dm(to, text) {
      const messageId = `relay_${++relaySeq}`;
      pushAction({
        kind: 'provider.write',
        status: 'previewed',
        provider: 'relaycast',
        resource: 'messages',
        data: { to, text, messageId }
      });
      return { ok: true, messageId };
    },
    async post(channel, text) {
      const messageId = `relay_${++relaySeq}`;
      pushAction({
        kind: 'provider.write',
        status: 'previewed',
        provider: 'relaycast',
        resource: 'messages',
        data: { channel, text, messageId }
      });
      return { ok: true, messageId };
    }
  };

  const previewTransport = new PreviewTransport();
  const restoreTransport = bindPreviewTransport(previewTransport);
  const restoreEnv = sanitizeProcessEnv(options.inputs ?? {});
  const restoreFetch = installFetchPolicy({
    policy: options.request.policy,
    fixtures: options.httpFixtures ?? [],
    pushAction,
    now
  });

  try {
    trace('route', 'started', 'invoke.start', 'invoke.start', {
      eventType: options.request.event.type
    });
    const bundleUrl = `${pathToFileURL(options.bundlePath).href}?invoke=${randomUUID()}`;
    const userModule = (await import(bundleUrl)) as Record<string, unknown>;
    const handler = extractHandler(userModule);
    const event = envelopeToAgentEvent(eventFrameToRawEnvelope(options.request.event));
    if (!event) throw new Error(`invoke: unsupported event ${options.request.event.type}`);

    const ctx = buildCtx({
      persona: options.request.agent.persona,
      workspaceId: options.request.event.workspace,
      agent: {
        id: 'local-agent',
        deployedName: options.request.agent.persona.id,
        spawnedByAgentId: null,
        inputValues: options.inputs ?? {}
      },
      deployment: {
        id: 'local-deployment',
        triggerKind: event.type === 'cron.tick' ? 'clock' : 'inbox',
        parentDeploymentId: null
      },
      sandbox,
      files: fileCtx,
      llm,
      memory: memoryCtx,
      workflow,
      schedule,
      relay,
      log,
      harnessRunner: async ({ prompt }) => {
        pushAction({
          kind: 'harness.run',
          status: 'previewed',
          data: { promptChars: prompt.length }
        });
        return { output: '', exitCode: 0, durationMs: 0 };
      }
    });

    let error: string | undefined;
    try {
      await (handler as WorkforceHandler)(ctx, event);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }

    for (const action of previewTransport.actions) {
      pushAction(transportActionToPreviewAction(action));
    }
    for (const access of previewTransport.accesses) {
      pushAction(transportActionToPreviewAction(access));
    }

    const record: RunRecordV2 = {
      runId,
      status: error ? 'failed' : 'succeeded',
      origin: 'local_dry_run',
      mode: options.request.mode,
      policy: clonePolicy(options.request.policy),
      eventId: options.request.event.id,
      eventContract: `${options.request.event.type}@${options.request.event.contractVersion}`,
      trace: traces,
      actions,
      artifacts: { artifacts: [] },
      stateDiff: {
        files: diffFiles(filesBefore, files),
        memory: memory.map((entry) => ({
          id: entry.id,
          scope: entry.scope,
          tags: entry.tags,
          createdAt: entry.createdAt
        }))
      },
      extensions: {
        logs,
        stateSource: options.request.state,
        ...(options.replayProvenance ? { provenance: options.replayProvenance } : {})
      },
      ...(error ? { error } : {})
    };

    trace('result', error ? 'failed' : 'succeeded', error ?? 'invoke.ok', 'invoke.result');
    return {
      record,
      exitCode: error ? 1 : 0,
      logs,
      state: {
        files: Object.fromEntries(files.entries()),
        memory
      }
    };
  } finally {
    restoreFetch();
    restoreEnv();
    restoreTransport();
  }
}

function extractHandler(userModule: Record<string, unknown>): WorkforceHandler {
  const exported = (userModule.default ?? userModule.handler) as
    | { __workforceAgent?: boolean; handler?: unknown }
    | ((...args: unknown[]) => unknown)
    | undefined;
  let candidate: unknown;
  if (exported && typeof exported === 'object' && exported.__workforceAgent) {
    candidate = exported.handler;
  } else if (exported && typeof exported === 'object' && typeof exported.handler === 'function') {
    candidate = exported.handler;
  } else {
    candidate = exported;
  }
  if (typeof candidate !== 'function') {
    throw new Error('invoke: bundle did not export a callable handler');
  }
  return candidate as WorkforceHandler;
}

function eventFrameToRawEnvelope(frame: EventFrameV1): RawGatewayEnvelope {
  return {
    id: frame.id,
    workspace: frame.workspace,
    type: frame.type,
    occurredAt: frame.occurredAt,
    attempt: frame.attempt,
    resource: frame.payload ?? frame.resource,
    summary: frame.summary,
    digest: frame.digest,
    provider: frame.resource.provider,
    deliveryId: frame.delivery?.id,
    paths: frame.paths ?? [frame.resource.path],
    name: frame.schedule?.name,
    cron: frame.schedule?.cron,
    channel: frame.message?.channel,
    messageId: frame.message?.messageId,
    threadId: frame.message?.threadId
  };
}

function stubModelOutput(prompt: string): string {
  if (prompt.includes('Return ONLY compact JSON with this shape:')) {
    const lines = prompt.trim().split('\n');
    const rawStories = lines[lines.length - 1] ?? '[]';
    try {
      const parsed = JSON.parse(rawStories) as Array<{ id?: number; title?: string }>;
      return JSON.stringify({
        theme: 'Agent infrastructure stories worth monitoring.',
        stories: parsed.map((story) => ({
          id: story.id,
          why: `Relevant to agent builders: ${String(story.title ?? 'story').slice(0, 120)}`
        }))
      });
    } catch {
      return JSON.stringify({
        theme: 'Agent infrastructure stories worth monitoring.',
        stories: []
      });
    }
  }
  return 'Agent-focused summary: the grounded story matters for runtime and orchestration work.';
}

function clonePolicy(policy: EffectPolicyV1): EffectPolicyV1 {
  return {
    ...policy,
    allowedHttp: policy.allowedHttp.map((rule) => ({ ...rule })),
    ...(policy.allowedProviders ? { allowedProviders: [...policy.allowedProviders] } : {})
  };
}

function diffFiles(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>
): Array<{ path: string; before?: string; after?: string }> {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .sort()
    .flatMap((path) => {
      const prev = before.get(path);
      const next = after.get(path);
      return prev === next ? [] : [{ path, ...(prev !== undefined ? { before: prev } : {}), ...(next !== undefined ? { after: next } : {}) }];
    });
}

function transportActionToPreviewAction(action: TransportPreviewAction): PreviewAction {
  return {
    kind: action.kind,
    status: action.status,
    provider: action.provider,
    resource: action.resource,
    ...(action.id ? { id: action.id } : {}),
    ...(action.method ? { method: action.method } : {}),
    ...(action.path ? { path: action.path } : {}),
    ...(action.parameters ? { parameters: action.parameters } : {}),
    ...(action.body !== undefined ? { body: action.body } : {}),
    ...(action.simulatedReceipt ? { simulatedReceipt: action.simulatedReceipt } : {}),
    data: {
      ...action.data,
      method: action.method,
      path: action.path,
      ...(action.parameters ? { parameters: action.parameters } : {}),
      ...(action.body !== undefined ? { body: action.body } : {}),
      ...(action.simulatedReceipt ? { simulatedReceipt: action.simulatedReceipt } : {})
    }
  };
}

function sanitizeProcessEnv(inputs: Record<string, string>): () => void {
  const original = { ...process.env };
  const keep = new Set([
    'HOME',
    'LANG',
    'LC_ALL',
    'LOGNAME',
    'NODE_ENV',
    'PATH',
    'PWD',
    'SHELL',
    'TERM',
    'TMP',
    'TMPDIR',
    'TZ',
    'USER'
  ]);
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(original)) {
    if (keep.has(key)) next[key] = value;
  }
  for (const [key, value] of Object.entries(inputs)) {
    next[key] = value;
    next[`WORKFORCE_INPUT_${key}`] = value;
  }
  process.env = next;
  return () => {
    process.env = original;
  };
}

function installFetchPolicy(args: {
  policy: EffectPolicyV1;
  fixtures: readonly LocalHttpFixture[];
  pushAction: (action: PreviewAction) => void;
  now: () => Date;
}): () => void {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : String(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET') ?? 'GET').toUpperCase();
    const fixture = args.fixtures.find((candidate) =>
      candidate.method.toUpperCase() === method && url.includes(candidate.match)
    );
    if (fixture) {
      args.pushAction({
        kind: 'http.read',
        status: 'previewed',
        data: {
          method,
          url,
          source: fixture.sourcePath ?? 'fixture'
        }
      });
      return new Response(fixture.body, {
        status: 200,
        headers: {
          'content-type': fixture.contentType ?? 'application/json'
        }
      });
    }

    if (args.policy.reads !== 'live' || !['GET', 'HEAD'].includes(method)) {
      args.pushAction({
        kind: 'http.read',
        status: 'denied',
        data: { method, url }
      });
      throw new Error(`invoke policy denied ${method} ${url}`);
    }

    if (args.policy.allowedHttp.length > 0 && !args.policy.allowedHttp.some((rule) => httpRuleMatches(rule, method, url))) {
      args.pushAction({
        kind: 'http.read',
        status: 'denied',
        data: { method, url }
      });
      throw new Error(`invoke policy denied undeclared live read ${method} ${url}`);
    }

    args.pushAction({
      kind: 'http.read',
      status: 'previewed',
      data: { method, url, source: 'live', at: args.now().toISOString() }
    });
    return await originalFetch(input as RequestInfo, init);
  }) as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function httpRuleMatches(
  rule: { method: string; urlGlob: string },
  method: string,
  url: string
): boolean {
  if (rule.method.toUpperCase() !== method.toUpperCase()) return false;
  const pattern = rule.urlGlob.includes('*')
    ? new RegExp(`^${rule.urlGlob.split('*').map(escapeRegExp).join('.*')}$`)
    : null;
  return pattern ? pattern.test(url) : url.includes(rule.urlGlob);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
