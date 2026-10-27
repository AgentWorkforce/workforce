import type {
  EffectPolicyV1,
  PreviewAction,
  RunRecordV2,
  RunRequestV1
} from './run-contracts.js';
import type { MemoryItem } from './types.js';

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

export interface LocalPreviewTransportReceipt {
  id: string;
  timestamp: string;
}

export interface LocalPreviewTransportState {
  sequence: number;
  data: Record<string, unknown>;
  writtenPaths: string[];
  receiptsByReference: Record<string, LocalPreviewTransportReceipt>;
}

export interface LocalPreviewModelState {
  fixtureCursor: number;
}

export interface LocalPreviewState {
  files?: Record<string, string>;
  memory?: LocalPreviewMemoryEntry[];
  transport?: LocalPreviewTransportState;
  model?: LocalPreviewModelState;
}

export interface LocalModelFixture {
  output: string;
  sourcePath?: string;
}

export interface LocalSourceFidelity {
  state: 'historical' | 'current' | 'fixture' | 'simulated' | 'unavailable';
  inputs: 'historical' | 'current' | 'fixture' | 'simulated' | 'unavailable';
  http: 'historical' | 'current' | 'fixture' | 'simulated' | 'unavailable';
  model: 'historical' | 'current' | 'fixture' | 'simulated' | 'unavailable';
  extensions?: Record<string, unknown>;
}

export interface ExecuteLocalRunOptions {
  request: RunRequestV1;
  bundlePath: string;
  sourcePath?: string;
  inputs?: Record<string, string>;
  state?: LocalPreviewState;
  httpFixtures?: readonly LocalHttpFixture[];
  modelFixtures?: readonly LocalModelFixture[];
  replayProvenance?: Record<string, unknown>;
  sourceFidelity?: LocalSourceFidelity;
  modelAdapter?: {
    complete: (prompt: string, opts?: { maxTokens?: number }) => Promise<string>;
  };
  now?: () => Date;
}

export interface ExecuteLocalRunResult {
  record: RunRecordV2;
  exitCode: 0 | 1;
  logs: string[];
  state: LocalPreviewState;
}

export interface LocalPreviewGuardConfig {
  policy: EffectPolicyV1;
  fixtures: readonly LocalHttpFixture[];
  transportState?: LocalPreviewTransportState;
  clockNow?: string;
}

export interface LocalPreviewWorkerPayload {
  request: RunRequestV1;
  bundlePath: string;
  inputs?: Record<string, string>;
  state?: LocalPreviewState;
  replayProvenance?: Record<string, unknown>;
  sourceFidelity?: LocalSourceFidelity;
}

export interface LocalPreviewWorkerInitMessage {
  type: 'init';
  config: LocalPreviewGuardConfig;
  payload: LocalPreviewWorkerPayload;
}

export interface LocalPreviewWorkerReadyMessage {
  type: 'ready';
}

export interface LocalPreviewFetchRequestMessage {
  type: 'fetch';
  requestId: string;
  method: string;
  url: string;
  headers: Array<[string, string]>;
  bodyBase64?: string;
}

export interface LocalPreviewFetchResponseMessage {
  type: 'fetch-response';
  requestId: string;
  ok: boolean;
  action: PreviewAction;
  response?: {
    status: number;
    headers: Array<[string, string]>;
    bodyBase64: string;
  };
  error?: string;
}

export interface LocalPreviewModelRequestMessage {
  type: 'model';
  requestId: string;
  prompt: string;
  maxTokens?: number;
}

export interface LocalPreviewModelResponseMessage {
  type: 'model-response';
  requestId: string;
  ok: boolean;
  action: PreviewAction;
  output?: string;
  error?: string;
}

export interface LocalPreviewWorkerResultMessage {
  type: 'result';
  result: LocalPreviewWorkerResult;
}

export type LocalPreviewWorkerInboundMessage =
  | LocalPreviewWorkerInitMessage
  | LocalPreviewFetchResponseMessage
  | LocalPreviewModelResponseMessage;

export type LocalPreviewWorkerOutboundMessage =
  | LocalPreviewWorkerReadyMessage
  | LocalPreviewFetchRequestMessage
  | LocalPreviewModelRequestMessage
  | LocalPreviewWorkerResultMessage;

export interface LocalPreviewWorkerSuccess extends ExecuteLocalRunResult {
  ok: true;
}

export interface LocalPreviewWorkerFailure {
  ok: false;
  error: string;
  stack?: string;
}

export type LocalPreviewWorkerResult = LocalPreviewWorkerSuccess | LocalPreviewWorkerFailure;

export interface PreviewProcessState {
  activateUserImportGuard: () => void;
  cleanup: () => void;
  fetchFromParent: (request: LocalPreviewFetchRequestMessage) => Promise<LocalPreviewFetchResponseMessage>;
  completeModelFromParent: (request: LocalPreviewModelRequestMessage) => Promise<LocalPreviewModelResponseMessage>;
  now: () => Date;
  previewTransport: {
    actions: PreviewAction[];
    accesses: PreviewAction[];
  };
  snapshotTransportState: () => LocalPreviewTransportState;
  recordAction: (action: PreviewAction) => void;
  recordedActions: PreviewAction[];
}
