import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { EventFrameV1 } from '@agentworkforce/events';
import { buildCtx } from './ctx.js';
import { getPreviewProcessState, transportActionToPreviewAction } from './local-preview-hooks.js';
import type {
  ExecuteLocalRunResult,
  LocalPreviewMemoryEntry,
  LocalPreviewState,
  LocalPreviewWorkerPayload
} from './local-preview-contract.js';
import { envelopeToAgentEvent } from './to-agent-event.js';
import type { RawGatewayEnvelope } from './shim.js';
import type {
  PreviewAction,
  RunRecordV2,
  RunTraceEventV1
} from './run-contracts.js';
import type {
  FilesContext,
  MemoryContext,
  RelayContext,
  SandboxContext,
  ScheduleContext,
  WorkflowContext,
  WorkforceCtx,
  WorkforceHandler
} from './types.js';

export async function executeLocalRunInWorkerProcess(
  payload: LocalPreviewWorkerPayload
): Promise<ExecuteLocalRunResult> {
  const previewState = getPreviewProcessState();
  if (!previewState) {
    throw new Error('invoke: preview worker hooks were not installed before bundle import');
  }

  const logs: string[] = [];
  const files = new Map<string, string>(Object.entries(payload.state?.files ?? {}));
  const memory = [...(payload.state?.memory ?? [])];
  const filesBefore = new Map(files);
  const runId = `run_local_${randomUUID()}`;
  let relaySeq = 0;
  let memorySeq = 0;
  let workflowSeq = 0;
  let scheduleSeq = 0;

  const recordAction = (action: PreviewAction): void => {
    previewState.recordAction(action);
  };

  const log: WorkforceCtx['log'] = (level, message, attrs) => {
    const payloadLine = { t: previewState.now().toISOString(), level, message, ...(attrs ?? {}) };
    logs.push(JSON.stringify(payloadLine));
  };

  const sandbox: SandboxContext = {
    cwd: '/preview',
    async exec(cmd) {
      if (payload.request.policy.shell === 'deny') {
        recordAction({
          kind: 'shell.exec',
          status: 'denied',
          data: { cmd }
        });
        throw new Error(`invoke policy denied shell execution: ${cmd}`);
      }
      recordAction({
        kind: 'shell.exec',
        status: 'previewed',
        data: { cmd }
      });
      return { output: '', exitCode: 0 };
    },
    async readFile(filePath) {
      const value = files.get(filePath);
      if (value === undefined) throw new Error(`preview file not found: ${filePath}`);
      return value;
    },
    async writeFile(filePath, contents) {
      files.set(filePath, contents);
      recordAction({
        kind: 'files.write',
        status: 'previewed',
        data: { path: filePath, bytes: contents.length }
      });
    }
  };

  const fileCtx: FilesContext = {
    async read(filePath) {
      const value = files.get(filePath);
      if (value === undefined) throw new Error(`preview file not found: ${filePath}`);
      return value;
    },
    async write(filePath, contents) {
      files.set(filePath, contents);
      recordAction({
        kind: 'files.write',
        status: 'previewed',
        data: { path: filePath, bytes: contents.length }
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
        createdAt: previewState.now().toISOString()
      };
      memory.push(entry);
      recordAction({
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
      recordAction({
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
      recordAction({
        kind: 'model.complete',
        status: 'previewed',
        data: {
          mode: payload.request.policy.model,
          promptChars: prompt.length,
          outputChars: output.length
        }
      });
      return output;
    }
  };

  const workflow: WorkflowContext = {
    async run(name, args) {
      if (payload.request.policy.compose === 'deny') {
        recordAction({
          kind: 'compose.run',
          status: 'denied',
          data: { name, args }
        });
        throw new Error(`invoke policy denied workflow.run("${name}")`);
      }
      const workflowRunId = `wf_${++workflowSeq}`;
      recordAction({
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
    async status(existingRunId) {
      recordAction({
        kind: 'compose.status',
        status: 'previewed',
        data: { runId: existingRunId, status: 'success' }
      });
      return { status: 'success' as const };
    }
  };

  const schedule: ScheduleContext = {
    async at(when, triggerPayload) {
      recordAction({
        kind: 'schedule.at',
        status: 'previewed',
        data: {
          id: `schedule_${++scheduleSeq}`,
          when: when.toISOString(),
          payload: triggerPayload
        }
      });
    },
    async cancel(name) {
      recordAction({
        kind: 'schedule.cancel',
        status: 'previewed',
        data: { name }
      });
    }
  };

  const relay: RelayContext = {
    async dm(to, text) {
      const messageId = `relay_${++relaySeq}`;
      recordAction({
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
      recordAction({
        kind: 'provider.write',
        status: 'previewed',
        provider: 'relaycast',
        resource: 'messages',
        data: { channel, text, messageId }
      });
      return { ok: true, messageId };
    }
  };

  const routeStartTrace: RunTraceEventV1 = {
    schemaVersion: 1,
    seq: 1,
    at: previewState.now().toISOString(),
    runId,
    spanId: `${runId}_span_1`,
    kind: 'invoke.start',
    phase: 'route',
    status: 'started',
    summary: 'invoke.start',
    data: {
      eventType: payload.request.event.type
    }
  };

  previewState.activateUserImportGuard();
  const bundleUrl = `${pathToFileURL(payload.bundlePath).href}?invoke=${randomUUID()}`;
  const userModule = (await import(bundleUrl)) as Record<string, unknown>;
  const handler = extractHandler(userModule);
  const event = envelopeToAgentEvent(eventFrameToRawEnvelope(payload.request.event));
  if (!event) throw new Error(`invoke: unsupported event ${payload.request.event.type}`);

  const ctx = buildCtx({
    persona: payload.request.agent.persona,
    workspaceId: payload.request.event.workspace,
    agent: {
      id: 'local-agent',
      deployedName: payload.request.agent.persona.id,
      spawnedByAgentId: null,
      inputValues: payload.inputs ?? {}
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
      recordAction({
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

  for (const action of previewState.previewTransport.actions) {
    recordAction(transportActionToPreviewAction(action as unknown as never));
  }
  for (const access of previewState.previewTransport.accesses) {
    recordAction(transportActionToPreviewAction(access as unknown as never));
  }

  const actionTraces = buildActionTraces(runId, previewState.recordedActions, previewState.now);
  const resultTrace: RunTraceEventV1 = {
    schemaVersion: 1,
    seq: actionTraces.length + 2,
    at: previewState.now().toISOString(),
    runId,
    spanId: `${runId}_span_${actionTraces.length + 2}`,
    kind: 'invoke.result',
    phase: 'result',
    status: error ? 'failed' : 'succeeded',
    summary: error ?? 'invoke.ok'
  };

  const record: RunRecordV2 = {
    runId,
    status: error ? 'failed' : 'succeeded',
    origin: 'local_dry_run',
    mode: payload.request.mode,
    policy: clonePolicy(payload.request.policy),
    eventId: payload.request.event.id,
    eventContract: `${payload.request.event.type}@${payload.request.event.contractVersion}`,
    trace: [routeStartTrace, ...actionTraces, resultTrace],
    actions: [...previewState.recordedActions],
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
      stateSource: payload.request.state,
      ...(payload.replayProvenance ? { provenance: payload.replayProvenance } : {})
    },
    ...(error ? { error } : {})
  };

  return {
    record,
    exitCode: error ? 1 : 0,
    logs,
    state: {
      files: Object.fromEntries(files.entries()),
      memory
    }
  };
}

function buildActionTraces(
  runId: string,
  actions: readonly PreviewAction[],
  now: () => Date
): RunTraceEventV1[] {
  return actions.map((action, index) => ({
    schemaVersion: 1,
    seq: index + 2,
    at: now().toISOString(),
    runId,
    spanId: `${runId}_span_${index + 2}`,
    kind: action.kind,
    phase: action.kind === 'provider.write'
      ? 'write'
      : action.kind === 'provider.read' || action.kind === 'http.read'
        ? 'read'
        : action.kind === 'model.complete'
          ? 'model'
          : action.kind.startsWith('compose.')
            ? 'compose'
            : 'result',
    status: action.status === 'denied'
      ? 'denied'
      : action.status === 'previewed'
        ? 'previewed'
        : 'succeeded',
    summary: action.kind,
    ...(action.data ? { data: action.data } : {})
  }));
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

function clonePolicy(policy: LocalPreviewWorkerPayload['request']['policy']) {
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
    .flatMap((filePath) => {
      const prev = before.get(filePath);
      const next = after.get(filePath);
      return prev === next
        ? []
        : [{
            path: filePath,
            ...(prev !== undefined ? { before: prev } : {}),
            ...(next !== undefined ? { after: next } : {})
          }];
    });
}
