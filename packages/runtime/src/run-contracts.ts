import type { EventFrameV1 } from '@agentworkforce/events';
import type { AgentSpec, PersonaSpec } from '@agentworkforce/persona-kit';

export interface Diagnostic {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  path?: string;
  extensions?: Record<string, unknown>;
}

/** Stable compiler output shared by deploy, invoke, and Run construction. */
export interface CompiledAgentV1 {
  schemaVersion: 1;
  sourceKind: 'single-file' | 'split';
  sourcePath: string;
  persona: PersonaSpec;
  agent: AgentSpec;
  handlerEntry: string;
  sourceDigest: string;
  compileWarnings: Diagnostic[];
  extensions?: Record<string, unknown>;
}

export type RunMode = 'simulate' | 'preview' | 'sandbox' | 'hosted' | 'replay';

export interface EffectPolicyV1 {
  reads: 'deny' | 'fixtures' | 'live';
  writes: 'deny' | 'preview' | 'sandbox' | 'live';
  model: 'stub' | 'fixture' | 'live';
  shell: 'deny' | 'simulate' | 'sandbox' | 'live';
  compose: 'deny' | 'preview' | 'sandbox' | 'live';
  allowedHttp: Array<{ method: string; urlGlob: string }>;
  allowedProviders?: string[];
}

/** Safe policy floor used by local invoke before case-specific narrowing. */
const EMPTY_ALLOWED_HTTP = Object.freeze([]) as unknown as EffectPolicyV1['allowedHttp'];

export const LOCAL_EFFECT_POLICY_DEFAULTS: Readonly<EffectPolicyV1> = Object.freeze({
  reads: 'fixtures',
  writes: 'preview',
  model: 'stub',
  shell: 'simulate',
  compose: 'preview',
  allowedHttp: EMPTY_ALLOWED_HTTP
});

export interface StateSourceV1 {
  schemaVersion: 1;
  kind: 'empty' | 'fixtures' | 'workspace' | 'replay';
  ref?: string;
  fidelity?: 'historical' | 'current' | 'fixture' | 'simulated' | 'unavailable';
  extensions?: Record<string, unknown>;
}

export interface RunRequestV1 {
  schemaVersion: 1;
  agent: CompiledAgentV1;
  event: EventFrameV1;
  mode: RunMode;
  inputs: Record<string, string>;
  policy: EffectPolicyV1;
  state: StateSourceV1;
  clock?: { now: string };
  parentRunId?: string;
  composeId?: string;
}

export interface RunTraceEventV1 {
  schemaVersion: 1;
  seq: number;
  at: string;
  runId: string;
  parentSpanId?: string;
  spanId: string;
  kind: string;
  phase: 'route' | 'read' | 'decide' | 'model' | 'write' | 'compose' | 'result';
  status: 'started' | 'succeeded' | 'failed' | 'denied' | 'previewed';
  summary: string;
  data?: Record<string, unknown>;
  artifactRefs?: string[];
}

export interface PreviewAction {
  id?: string;
  kind: string;
  provider?: string;
  resource?: string;
  status?: 'denied' | 'previewed' | 'sandboxed' | 'executed';
  data?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface RunArtifactEntry {
  id: string;
  kind: string;
  path?: string;
  mediaType?: string;
  redacted: boolean;
  extensions?: Record<string, unknown>;
}

export interface RunArtifactManifest {
  artifacts: RunArtifactEntry[];
  extensions?: Record<string, unknown>;
}

export interface StateDiff {
  files?: Array<{ path: string; before?: string; after?: string }>;
  memory?: Array<Record<string, unknown>>;
  providers?: Array<Record<string, unknown>>;
  extensions?: Record<string, unknown>;
}

/** Additive common record; hosted/local implementations may retain existing fields. */
export interface RunRecordV2 {
  runId: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  origin: 'local_dry_run' | 'hosted';
  mode: RunRequestV1['mode'];
  policy: EffectPolicyV1;
  eventId: string;
  eventContract: string;
  trace: RunTraceEventV1[];
  actions: PreviewAction[];
  artifacts: RunArtifactManifest;
  stateDiff: StateDiff;
  /** Existing Run fields remain serializable while producers migrate additively. */
  [field: string]: unknown;
}

/** Apply local defaults while preventing callers from escalating local effects. */
export function resolveLocalEffectPolicy(
  requested: Partial<EffectPolicyV1> = {}
): EffectPolicyV1 {
  return {
    reads: requested.reads ?? LOCAL_EFFECT_POLICY_DEFAULTS.reads,
    writes: requested.writes === 'deny' ? 'deny' : 'preview',
    model: requested.model ?? LOCAL_EFFECT_POLICY_DEFAULTS.model,
    shell: requested.shell === 'deny' ? 'deny' : 'simulate',
    compose: requested.compose === 'deny' ? 'deny' : 'preview',
    allowedHttp: (requested.allowedHttp ?? LOCAL_EFFECT_POLICY_DEFAULTS.allowedHttp)
      .map((rule) => ({ ...rule })),
    ...(requested.allowedProviders ? { allowedProviders: [...requested.allowedProviders] } : {})
  };
}
